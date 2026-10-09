// Turn an alert sentence into typed questions and a rule with gpt-6-luna (Responses API, JSON mode).
// A TypeScript port of pipeline/03_compile.py (prompt v5) and the CompiledAlert checks in
// pipeline/rules.py, so the page compiles alerts the way the July 22 run did: extract the intent,
// compile, validate, dry-run the questions through the Decisions API, and feed any failure back to
// the model, up to 3 attempts. Only the snapshot description differs (hourly, not 5-minute).

import { leaves, parse, type Node } from "../rule.ts";
import type { Question } from "../types.ts";
import { ApiError, decide, generate, type Client, type Message } from "./openai.ts";
import { SNAPSHOT_DESCRIPTION } from "./snapshot.ts";

const SYSTEM = `You compile a power-market alert written in plain English into a few typed questions for a \
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
 "rule": "wind_falling >= 0.7 && pressure != 'nothing unusual' && urgency >= 1.5"}`;

const INTENT_SYSTEM = `Read a power-market alert written in plain English and state what the user wants to \
be alerted about, in their own terms. Return JSON only:
{"want": "<the condition they want to hear about, a short phrase>", \
"avoid": "<the look-alike condition they explicitly do NOT want to hear about, a short phrase, or null>"}`;

export interface Intent { want: string; avoid: string | null }
export interface Contrast { question: string; want: string; avoid: string }

export interface Compiled {
  sentence: string;
  alert_id: string;
  questions: Question[];
  primary: string;
  contrast: Contrast | null;
  rule: string;
  intent: Intent;
  attempts: { raw: string; error?: string }[];
}

class Invalid extends Error {}

function userPrompt(sentence: string, intent: Intent): string {
  let msg = `Alert: "${sentence}"\n\nThe user wants: ${intent.want}.`;
  if (intent.avoid) {
    msg += `\nThe user does NOT want: ${intent.avoid}.\nSo the primary question asks whether "${intent.want}" is true, and ` +
      `the contrast question is a choice question ("Which best describes ... right now?") with one option for ` +
      `"${intent.want}" (want), one for "${intent.avoid}" (avoid), and "nothing unusual".`;
  }
  return `${msg}\n\nEach snapshot describes: ${SNAPSHOT_DESCRIPTION}`;
}

const STOP = new Set(["the", "a", "an", "is", "of", "to", "in", "due", "toward", "towards", "ercot", "prices", "price", "spike", "spikes"]);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));

/** Shared content words (crude stem: first 5 letters), to check contrast labels against the intent. */
function overlap(a: string, b: string): number {
  const wa = words(a);
  return [...words(b)].filter((w) => wa.has(w)).length;
}

/** Syntax-only cleanup: gpt-6-luna often writes option labels in snake_case ("nothing_unusual"). */
function normalize(d: any): any {
  const fix = (label: unknown) => (typeof label === "string" ? label.replace(/_/g, " ") : label);
  if (!d || typeof d !== "object") return d;
  for (const q of Array.isArray(d.questions) ? d.questions : []) {
    if (q && typeof q === "object" && q.kind !== "score" && Array.isArray(q.options)) q.options = q.options.map(fix);
  }
  if (d.contrast && typeof d.contrast === "object") {
    d.contrast.want = fix(d.contrast.want);
    d.contrast.avoid = fix(d.contrast.avoid);
  }
  if (typeof d.rule === "string") d.rule = d.rule.replace(/'([^']*)'/g, (_: string, s: string) => `'${fix(s)}'`);
  return d;
}

const NONE_OPTIONS = ["nothing unusual", "none of these"];

/** True if every way the rule can be true has the contrast question away from `avoid`. */
function excludes(n: Node, c: Contrast): boolean {
  if (n.k === "and") return excludes(n.a, c) || excludes(n.b, c);
  if (n.k === "or") return excludes(n.a, c) && excludes(n.b, c);
  if (n.k !== "cmp" || n.qid !== c.question) return false;
  if (n.option === null) return (n.op === "==" && n.value === c.want) || (n.op === "!=" && n.value === c.avoid);
  if (typeof n.value !== "number") return false;
  if (n.option === c.want) return (n.op === ">=" || n.op === ">") && n.value >= 0.5;
  if (n.option === c.avoid) return (n.op === "<" || n.op === "<=") && n.value <= 0.5;
  return false;
}

/** The CompiledAlert checks from pipeline/rules.py. Throws Invalid with a message the model can act on. */
function validate(d: any): Omit<Compiled, "sentence" | "intent" | "attempts"> {
  if (!d || typeof d !== "object") throw new Invalid("expected a JSON object");
  if (typeof d.alert_id !== "string" || !/^[a-z][a-z0-9_]{2,40}$/.test(d.alert_id)) throw new Invalid("alert_id must be snake_case, 3-41 characters");
  if (!Array.isArray(d.questions) || d.questions.length < 2 || d.questions.length > 4) throw new Invalid("use 2-4 questions");
  const questions: Question[] = d.questions.map((q: Question, n: number) => {
    if (!q || typeof q.id !== "string" || typeof q.text !== "string" || !["probability", "choice", "score"].includes(q.kind) ||
      !Array.isArray(q.options) || !q.options.every((o) => typeof o === "string"))
      throw new Invalid(`questions[${n}] needs a string id, a kind of probability, choice or score, a text, and a list of string options`);
    return { id: q.id, kind: q.kind, text: q.text, options: q.options };
  });
  const ids = questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) throw new Invalid("question ids must be unique");
  for (const q of questions) {
    if (!/^[a-z][a-z0-9_]*$/.test(q.id)) throw new Invalid(`question id '${q.id}' must be snake_case`);
    if (q.kind === "probability" && JSON.stringify(q.options) !== '["yes","no"]')
      throw new Invalid(`${q.id}: probability questions must have options ['yes', 'no']`);
    if (q.kind === "choice") {
      if (q.options.length < 2 || q.options.length > 6) throw new Invalid(`${q.id}: choice questions need 2-6 options`);
      if (!q.options.some((o) => NONE_OPTIONS.includes(o.toLowerCase())))
        throw new Invalid(`${q.id}: choice questions must include 'nothing unusual' or 'none of these'`);
    }
    if (q.kind === "score") {
      if (q.options.length < 3 || q.options.length > 5) throw new Invalid(`${q.id}: score questions need 3-5 ordered levels`);
      if (!q.options.every((o, k) => o.startsWith(`${k} `)))
        throw new Invalid(`${q.id}: score levels must be written '0 none', '1 mild', ... in order`);
    }
    if (new Set(q.options).size !== q.options.length) throw new Invalid(`${q.id}: duplicate options`);
  }
  if (typeof d.rule !== "string") throw new Invalid("rule must be a string");
  let tree: Node;
  try {
    tree = parse(d.rule, questions);
  } catch (e) {
    throw new Invalid(e instanceof Error ? e.message : String(e));
  }
  const qs = new Map(questions.map((q) => [q.id, q]));
  for (const c of leaves(tree)) {
    const q = qs.get(c.qid)!;
    if (typeof c.value === "number" && c.option === null && q.kind === "choice")
      throw new Invalid(`rule: compare choice ${q.id} to a label, or use ${q.id}.<option> for its probability`);
    if (typeof c.value === "string") {
      if (c.option !== null || q.kind !== "choice" || (c.op !== "==" && c.op !== "!="))
        throw new Invalid("rule: only a choice question can be compared to a label with == or !=");
      if (!q.options.includes(c.value)) throw new Invalid(`rule: ${q.id} has no option '${c.value}'`);
    }
  }
  const primary = d.primary;
  if (typeof primary !== "string" || qs.get(primary)?.kind !== "probability") throw new Invalid("primary must be the id of a probability question");
  if (!leaves(tree).some((c) => c.qid === primary)) throw new Invalid(`the rule must use the primary question '${primary}'`);
  let contrast: Contrast | null = null;
  if (d.contrast) {
    const c = d.contrast as Contrast;
    if (qs.get(c.question)?.kind !== "choice") {
      const choices = questions.filter((q) => q.kind === "choice").map((q) => `${q.id}: ${JSON.stringify(q.options)}`);
      throw new Invalid(`contrast.question is '${c.question}', which is not a choice question. ` + (choices.length
        ? `Your choice questions are ${choices.join("; ")}; set contrast.question to the one whose options include the want and avoid options.`
        : `Add a choice question like {"id": "situation", "kind": "choice", "text": "Which best describes the grid right now?", "options": ["<want>", "<avoid>", "nothing unusual"]}.`));
    }
    const opts = qs.get(c.question)!.options;
    if (!opts.includes(c.want) || !opts.includes(c.avoid) || c.want === c.avoid)
      throw new Invalid(`contrast.want and contrast.avoid must be two different options of ${c.question}: ${JSON.stringify(opts)}`);
    if (!excludes(tree, c))
      throw new Invalid(`the rule must rule out ${c.question} = '${c.avoid}', e.g. with ${c.question} == '${c.want}' or ${c.question} != '${c.avoid}' combined by &&`);
    contrast = { question: c.question, want: c.want, avoid: c.avoid };
  }
  return { alert_id: d.alert_id, questions, primary, contrast, rule: d.rule };
}

export async function compileAlert(c: Client, sentence: string, onAttempt?: (n: number) => void): Promise<Compiled> {
  const { text: intentRaw } = await generate(c, [
    { role: "system", content: INTENT_SYSTEM },
    { role: "user", content: `Alert: "${sentence}"` },
  ]);
  let intent: Intent;
  try {
    const j = JSON.parse(intentRaw);
    intent = { want: String(j.want), avoid: j.avoid ? String(j.avoid) : null };
  } catch {
    throw new Error("gpt-6-luna couldn't read the alert. Try rephrasing it as one sentence.");
  }

  const messages: Message[] = [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt(sentence, intent) }];
  const attempts: Compiled["attempts"] = [];
  for (let n = 1; n <= 3; n++) {
    onAttempt?.(n);
    const { text } = await generate(c, messages);
    const rec: Compiled["attempts"][number] = { raw: text };
    attempts.push(rec);
    let alert: ReturnType<typeof validate>;
    try {
      alert = validate(normalize(JSON.parse(text)));
      if (/\bnot\b/i.test(sentence) && !alert.contrast)
        throw new Invalid('the alert contrasts two things ("..., not ..."), so "contrast" must name the choice question and its "want" and "avoid" options, and the rule must rule out "avoid"');
      if (alert.contrast && intent.avoid) {
        const k = alert.contrast;
        if (overlap(k.want, intent.avoid) > overlap(k.want, intent.want) || overlap(k.avoid, intent.want) > overlap(k.avoid, intent.avoid))
          throw new Invalid(`contrast is inverted: "want" must be the option for "${intent.want}" and "avoid" the option for "${intent.avoid}", and the rule must rule out the avoid option`);
      }
    } catch (e) {
      if (!(e instanceof Invalid || e instanceof SyntaxError)) throw e;
      rec.error = (e instanceof SyntaxError ? `not valid JSON: ${e.message}` : e.message).slice(0, 800);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `That output is invalid: ${rec.error}\nReturn corrected JSON only.` });
      continue;
    }
    // Dry run: the Decisions API must accept every question.
    try {
      await decide(c, "It is noon in Texas.", alert.questions);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 400)) throw e;
      rec.error = `decision model rejected the questions: ${e.message}`.slice(0, 800);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `${rec.error}\nShorten the questions and options. Return JSON only.` });
      continue;
    }
    return { sentence, ...alert, intent, attempts };
  }
  throw new Error(`gpt-6-luna couldn't compile this alert in 3 attempts. The last problem: ${attempts[attempts.length - 1].error}`);
}
