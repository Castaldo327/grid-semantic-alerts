"""Compile each preset's plain-English alert into typed questions + a rule, once, with gpt-6-luna (Responses API).

Two gpt-6-luna calls: first extract the intent (what the user wants, and the look-alike they don't),
then write questions and a rule for that intent.

gpt-6-luna's output is validated with pydantic (rules.CompiledAlert), then dry-run through the Decisions API
so a question it would reject is caught here. Any failure is
fed back to gpt-6-luna, up to 3 attempts. Every raw response is saved next to the result.

The baseline threshold is the preset's, set here, not compiled by gpt-6-luna.
"""

import json
import re

from pydantic import ValidationError

from pipeline import luna
from pipeline.common import ALERTS, log, write_json
from pipeline.rules import CompiledAlert, Threshold

PRESETS = {
    "A": {
        "scenario": "record_load",
        "sentence": "Tell me when ERCOT is actually heading toward scarcity, not just setting demand records.",
        "baseline": Threshold(series="load_mw", op=">", value=90000),
        "baseline_label": "ERCOT load > 90,000 MW",
        "snapshot": "time of day; ERCOT demand vs. its forecast and its trend over the last hour; solar and wind "
                    "output; battery discharge and its trend; net load (demand minus wind and solar); hub real-time "
                    "price vs. day-ahead; non-spinning reserve price; physical responsive capability (operating "
                    "reserves) and its trend.",
    },
}

SYSTEM = """You compile a power-market alert written in plain English into a few typed questions for a \
decision model, plus a rule that combines its answers.

The decision model reads ONE short prose snapshot of the ERCOT grid at a time and returns a probability \
for every option of every question. It cannot generate text, look at history beyond what the snapshot \
says, or see other snapshots.

Prompt version: v5.

Return JSON only, with this shape:
{"alert_id": "<snake_case>", "questions": [{"id": "<snake_case>", "kind": "probability" | "choice" | "score", \
"text": "<the question>", "options": [...]}], "primary": "<id>", \
"contrast": {"question": "<id>", "want": "<option>", "avoid": "<option>"} | null, "rule": "<expression>"}

Question kinds:
- probability: a yes/no question. options must be exactly ["yes", "no"].
- choice: pick one of 2-6 short option labels.
- score: an ordered scale of 3-5 levels, lowest first, each written "<n> <word>", e.g. ["0 none", "1 mild", "2 serious", "3 severe"].

Rules:
1. Use 2-4 questions, each answerable from a single snapshot of grid state.
2. Every choice question must include a "nothing unusual" or "none of these" option, because the \
decision model always picks some option even when none fit.
3. Ask about the state of the world (e.g. "Is the grid short of supply?"), never about this app, alerts, or the user.
4. Keep question text to one sentence and option labels to a few words.
5. Start with one probability question that restates the user's condition as directly as possible, and make the rule gate mainly on it. Add only conditions the alert itself asks for.
6. If the alert contrasts two things ("X, not Y"), include a question whose options separate X from Y, and never let the rule require Y.
7. The rule may only reference question ids and option labels, using:
   <id>.<option> >= 0.7          probability of that option, 0..1 (quote labels with spaces: driver.'demand above forecast')
   <id> >= 0.7                   for a probability question: P(yes)
   <id> >= 1.5                   for a score question: the probability-weighted level
   <id> != 'nothing unusual'     for a choice question: its most likely option
   combined with &&, ||, ! and parentheses.
   Thresholds: 0.5-0.7 for probabilities; for a 0-3 score, 1.5 means "serious or worse".

Example (for a different alert, "Warn me if wind is dropping off fast while demand is still climbing"):
{"alert_id": "wind_dropoff", "primary": "wind_falling", "contrast": null, "questions": [
 {"id": "wind_falling", "kind": "probability", "text": "Is wind output falling quickly right now?", "options": ["yes", "no"]},
 {"id": "pressure", "kind": "choice", "text": "What is putting the most pressure on supply?", "options": ["rising demand", "falling wind", "falling solar", "nothing unusual"]},
 {"id": "urgency", "kind": "score", "text": "How urgent is the supply situation?", "options": ["0 none", "1 mild", "2 serious", "3 severe"]}],
 "rule": "wind_falling >= 0.7 && pressure != 'nothing unusual' && urgency >= 1.5"}"""


INTENT_SYSTEM = """Read a power-market alert written in plain English and state what the user wants to \
be alerted about, in their own terms. Return JSON only:
{"want": "<the condition they want to hear about, a short phrase>", \
"avoid": "<the look-alike condition they explicitly do NOT want to hear about, a short phrase, or null>"}"""


def extract_intent(p: dict) -> tuple[dict, dict]:
    content, ms = luna.chat([{"role": "system", "content": INTENT_SYSTEM},
                             {"role": "user", "content": f'Alert: "{p["sentence"]}"'}], fmt="json")
    intent = json.loads(content)
    return {"want": str(intent["want"]), "avoid": intent.get("avoid") or None}, {"raw": content, "latency_ms": round(ms)}


def user_prompt(p: dict, intent: dict) -> str:
    msg = f'Alert: "{p["sentence"]}"\n\nThe user wants: {intent["want"]}.'
    if intent["avoid"]:
        msg += (f'\nThe user does NOT want: {intent["avoid"]}.\nSo the primary question asks whether '
                f'"{intent["want"]}" is true, and the contrast question is a choice question ("Which best describes '
                f'... right now?") with one option for "{intent["want"]}" (want), one for "{intent["avoid"]}" '
                f'(avoid), and "nothing unusual".')
    msg += f"\n\nEach snapshot describes: {p['snapshot']}"
    return msg


STOP = {"the", "a", "an", "is", "of", "to", "in", "due", "toward", "towards", "ercot", "prices", "price", "spike", "spikes"}


def overlap(a: str, b: str) -> int:
    """Shared content words (crude stem: first 5 letters), to check contrast labels against the intent."""
    words = lambda s: {w[:5] for w in re.findall(r"[a-z]+", s.lower()) if w not in STOP}
    return len(words(a) & words(b))


def normalize(d: dict) -> tuple[dict, list[str]]:
    """Syntax-only cleanup before validation: gpt-6-luna often writes option labels in snake_case
    ("nothing_unusual"). Replace underscores with spaces in option labels, in contrast want/avoid,
    and in quoted labels in the rule. Question ids are untouched. Returns the changes made."""
    changes = []

    def fix(label):
        if isinstance(label, str) and "_" in label:
            changes.append(f"{label!r} -> {label.replace('_', ' ')!r}")
            return label.replace("_", " ")
        return label

    for q in d.get("questions", []):
        if isinstance(q, dict) and q.get("kind") != "score":
            q["options"] = [fix(o) for o in q.get("options", [])]
    if isinstance(d.get("contrast"), dict):
        for k in ("want", "avoid"):
            d["contrast"][k] = fix(d["contrast"].get(k))
    if isinstance(d.get("rule"), str):
        d["rule"] = re.sub(r"'([^']*)'", lambda m: "'" + fix(m.group(1)) + "'", d["rule"])
    return d, changes


def compile_preset(key: str, p: dict) -> dict:
    intent, intent_raw = extract_intent(p)
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_prompt(p, intent)}]
    attempts = []
    for attempt in range(1, 4):
        content, ms = luna.chat(messages, fmt="json")
        rec = {"attempt": attempt, "raw": content, "latency_ms": round(ms)}
        attempts.append(rec)
        try:
            data, rec["normalized"] = normalize(json.loads(content))
            alert = CompiledAlert.model_validate(data)
            if re.search(r"\bnot\b", p["sentence"]) and alert.contrast is None:
                raise ValueError('the alert contrasts two things ("..., not ..."), so "contrast" must name the choice '
                                 'question and its "want" and "avoid" options, and the rule must rule out "avoid"')
            if alert.contrast and intent["avoid"]:
                c = alert.contrast
                if overlap(c.want, intent["avoid"]) > overlap(c.want, intent["want"]) or overlap(
                    c.avoid, intent["want"]
                ) > overlap(c.avoid, intent["avoid"]):
                    raise ValueError(
                        f'contrast is inverted: "want" must be the option for "{intent["want"]}" and "avoid" the '
                        f'option for "{intent["avoid"]}", and the rule must rule out the avoid option'
                    )
            # Dry run: the decision model must accept every question.
            luna.decide("It is noon in Texas.", alert.questions)
        except (json.JSONDecodeError, ValidationError, ValueError) as exc:
            rec["error"] = str(exc)[:800]
            log.info("preset %s attempt %d invalid: %s", key, attempt, rec["error"][:200])
            messages += [{"role": "assistant", "content": content},
                         {"role": "user", "content": f"That output is invalid: {rec['error']}\nReturn corrected JSON only."}]
            continue
        except Exception as exc:  # the decision model rejected the questions
            rec["error"] = f"decision model rejected the questions: {exc}"[:800]
            messages += [{"role": "assistant", "content": content},
                         {"role": "user", "content": f"{rec['error']}\nShorten the questions and options. Return JSON only."}]
            continue
        return {
            "preset": key,
            "scenario": p["scenario"],
            "sentence": p["sentence"],
            **alert.model_dump(),
            "baseline_threshold": p["baseline"].model_dump(),
            "baseline_label": p["baseline_label"],
            "compiled_by": luna.info(),
            "intent": intent,
            "intent_raw": intent_raw,
            "attempts": attempts,
            "system_prompt": SYSTEM,
            "intent_system_prompt": INTENT_SYSTEM,
            "user_prompt": user_prompt(p, intent),
        }
    raise SystemExit(f"preset {key}: gpt-6-luna produced no valid alert in 3 attempts; see attempts: {attempts}")


def main() -> None:
    index = {}
    for key, p in PRESETS.items():
        out = compile_preset(key, p)
        write_json(ALERTS / f"{out['alert_id']}.json", out)
        index[key] = {"alert_id": out["alert_id"], "scenario": p["scenario"]}
        log.info("preset %s -> %s (%d attempts): %s", key, out["alert_id"], len(out["attempts"]), out["rule"])
    write_json(ALERTS / "index.json", index)


if __name__ == "__main__":
    main()
