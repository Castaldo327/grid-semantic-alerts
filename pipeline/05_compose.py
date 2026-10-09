"""Compose fire/no-fire for both methods and write one compact JSON per alert for the web app.

  - Semantic: evaluate the compiled `rule` on gpt-6-luna's answers at every interval.
  - Baseline: evaluate the preset threshold on the matching series.
  - Both use a 30-minute re-fire cooldown (like Grid Status's Notification Timeout): a firing
    happens when the condition is true and nothing fired in the previous 30 minutes.
  - gpt-6-luna writes a 1-2 sentence explanation for each semantic firing, and for each threshold
    firing the semantic alert declined. Every number in an explanation must appear in the state
    prose (checked; up to 3 attempts, then the explanation is kept and flagged).
The web app recomputes both firing lists in TypeScript from the same inputs and checks they match.
"""

import json
import re
import sys

import pandas as pd

from pipeline import luna
from pipeline.common import ALERTS, DECISIONS, STATE, WEB_DEMO, log, write_json
from pipeline.luna import Answer, Question
from pipeline.rules import Threshold, evaluate, parse, threshold_hit

COOLDOWN = pd.Timedelta(minutes=30)
DATASETS = {
    "record_load": ["ercot_load", "ercot_load_forecast_by_forecast_zone", "ercot_fuel_mix", "ercot_energy_storage_resources",
                    "ercot_lmp_by_settlement_point", "ercot_spp_day_ahead_hourly", "ercot_sced_system_lambda",
                    "ercot_mcpc_sced", "ercot_prc"],
    "local_spike": ["ercot_lmp_by_settlement_point", "ercot_shadow_prices_sced", "ercot_real_time_adders_and_reserves",
                    "ercot_sced_system_lambda", "ercot_spp_day_ahead_hourly", "ercot_load", "ercot_fuel_mix"],
}

EXPLAIN_SYSTEM = """You write one- or two-sentence notes for power traders about an ERCOT grid snapshot. \
Plain, specific, no hype, no exclamation marks, no advice. Use only facts and numbers that appear in the \
snapshot; do not compute new numbers. If the snapshot doesn't support a claim, don't make it. \
Describe the grid itself: never mention the alert, the decision model, probabilities, or "the snapshot". \
Return JSON only: {"note": "<1-2 sentences>"}"""

META = re.compile(r"probabilit|decision model|snapshot|the alert|threshold", re.I)


def cooldown(flags: list[bool], ts: list[pd.Timestamp]) -> list[int]:
    fired, last = [], None
    for i, (f, t) in enumerate(zip(flags, ts)):
        if f and (last is None or t - last >= COOLDOWN):
            fired.append(i)
            last = t
    return fired


def answers_text(questions: list[Question], ans: dict) -> str:
    lines = []
    for q in questions:
        probs = ans[q.id]["probs"]
        dist = ", ".join(f"{o} {p:.2f}" for o, p in probs.items())
        lines.append(f"- {q.text} -> {dist}")
    return "\n".join(lines)


NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def numbers(s: str) -> set[str]:
    return {n.replace(",", "").rstrip(".") for n in NUM.findall(s)}


def explain(kind: str, alert: dict, prose: str, ans: dict, questions: list[Question]) -> dict:
    if kind == "fired":
        task = (f'The alert "{alert["sentence"]}" fired on this snapshot. In 1-2 sentences, say which facts in '
                f"the snapshot point to that condition.")
    else:
        task = (f'A simple threshold alert ({alert["baseline_label"]}) fired on this snapshot, but the alert '
                f'"{alert["sentence"]}" did not. In 1-2 sentences, say what in the snapshot suggests this is not '
                f"what that alert is looking for")
        task += (", naming the binding constraint if one is relevant." if alert["scenario"] == "local_spike" else ".")
        task += " If the snapshot doesn't clearly support that, say so."
    user = (f"Snapshot:\n{prose}\n\nA decision model gave these probabilities (context only; don't quote them):\n"
            f"{answers_text(questions, ans)}\n\n{task}")
    messages = [{"role": "system", "content": EXPLAIN_SYSTEM}, {"role": "user", "content": user}]
    allowed = numbers(prose)
    tries = []
    for attempt in range(1, 4):
        content, ms = luna.chat(messages, fmt="json")
        try:
            note = str(json.loads(content)["note"]).strip()
        except (json.JSONDecodeError, KeyError, TypeError):
            tries.append({"raw": content, "error": "bad json"})
            continue
        extra = sorted(n for n in numbers(note) if n not in allowed)
        meta = sorted({m.group(0).lower() for m in META.finditer(note)})
        problems = {**({"unsupported_numbers": extra} if extra else {}), **({"meta_terms": meta} if meta else {})}
        tries.append({"raw": content, "latency_ms": round(ms), **problems})
        if not problems:
            return {"text": note, "attempts": len(tries), "checked": True}
        fix = []
        if extra:
            fix.append(f"these numbers are not in the snapshot: {extra}")
        if meta:
            fix.append(f"it talks about {meta} instead of the grid")
        messages += [{"role": "assistant", "content": content},
                     {"role": "user", "content": f"Rewrite: {'; '.join(fix)}. Describe only the grid, using only "
                                                 f"numbers from the snapshot. JSON only."}]
    last = next((t for t in reversed(tries) if "raw" in t and ("unsupported_numbers" in t or "meta_terms" in t)), None)
    note = json.loads(last["raw"])["note"] if last else ""
    return {"text": note, "attempts": len(tries), "checked": False,
            **({k: last[k] for k in ("unsupported_numbers", "meta_terms") if k in last} if last else {})}


def compose(alert: dict, state: dict, dec: dict, *, explain_on: bool = True) -> dict:
    questions = [Question(**q) for q in alert["questions"]]
    qmap = {q.id: q for q in questions}
    tree = parse(alert["rule"], qmap)
    ts = [pd.Timestamp(t) for t in state["t"]]
    rows = dec["rows"]
    assert [r["t"] for r in rows] == state["t"], "decision rows and state intervals are misaligned"

    sem_true = []
    for r in rows:
        ans = {qid: Answer(id=qid, kind=qmap[qid].kind, probs=a["probs"], expected=a.get("expected"), refused=a.get("refused", False))
               for qid, a in r["answers"].items()}
        sem_true.append(evaluate(tree, ans))
    thr = Threshold(**alert["baseline_threshold"])
    series = state["series"][thr.series]
    thr_true = [threshold_hit(thr, v) for v in series]
    sem_fired = cooldown(sem_true, ts)
    thr_fired = cooldown(thr_true, ts)

    explanations = {}
    if explain_on:
        for i in sem_fired:
            explanations[state["t"][i]] = {"kind": "fired",
                                           **explain("fired", alert, state["intervals"][i]["prose"], rows[i]["answers"], questions)}
        for i in thr_fired:
            if not sem_true[i]:
                explanations[state["t"][i]] = {"kind": "declined",
                                               **explain("declined", alert, state["intervals"][i]["prose"], rows[i]["answers"], questions)}
        log.info("%s: %d explanations (%d unchecked)", alert["alert_id"], len(explanations),
                 sum(not e["checked"] for e in explanations.values()))

    return {
        "alert": {k: alert[k] for k in ("preset", "alert_id", "sentence", "questions", "primary", "contrast", "rule",
                                         "baseline_threshold", "baseline_label", "intent")},
        "compile": {"model": alert["compiled_by"], "attempts": len(alert["attempts"]),
                    "errors": [a.get("error") for a in alert["attempts"] if a.get("error")]},
        "scenario": {k: state[k] for k in ("scenario", "title", "day", "timezone", "blog_url", "coarse_series",
                                            "series_source", "missing")},
        "datasets": DATASETS[state["scenario"]],
        "t": state["t"],
        "series": state["series"],
        "prose": [it["prose"] for it in state["intervals"]],
        "constraints": [it.get("constraints") for it in state["intervals"]] if state["scenario"] == "local_spike" else None,
        "decisions": [r["answers"] for r in rows],
        "decision_latency_ms": [r["latency_ms"] for r in rows],
        "rule_true": sem_true,
        "threshold_true": thr_true,
        "fired": {"semantic": sem_fired, "threshold": thr_fired},
        "cooldown_minutes": 30,
        "explanations": explanations,
        "explained_by": luna.info(),
        "model": dec["model"],
        "decision_stats": dec["stats"],
    }


def main() -> None:
    index = json.loads((ALERTS / "index.json").read_text())
    manifest = []
    for key, entry in index.items():
        alert = json.loads((ALERTS / f"{entry['alert_id']}.json").read_text())
        state = json.loads((STATE / f"{entry['scenario']}.json").read_text())
        dec = json.loads((DECISIONS / f"{entry['alert_id']}.json").read_text())
        out = compose(alert, state, dec, explain_on="--no-explain" not in sys.argv)
        path = WEB_DEMO / f"{entry['alert_id']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False) + "\n")
        manifest.append({"preset": key, "alert_id": entry["alert_id"], "scenario": entry["scenario"],
                         "file": f"demo/{entry['alert_id']}.json"})
        log.info("%s: threshold fired %d, semantic fired %d, rule true at %d intervals", entry["alert_id"],
                 len(out["fired"]["threshold"]), len(out["fired"]["semantic"]), sum(out["rule_true"]))
    write_json(WEB_DEMO / "index.json", manifest)


if __name__ == "__main__":
    main()
