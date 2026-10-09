// The compose step in plain TypeScript: parse the compiled rule, evaluate it on each interval's
// answers, and apply the re-fire cooldown. Twin of pipeline/rules.py; the page recomputes every
// firing with this code and checks it matches the precomputed JSON.
//
// Grammar: or := and ("||" and)* ; and := not ("&&" not)* ; not := "!" not | "(" or ")" | cmp
//          cmp := qid ["." option] OP (number | 'label')     OP: >= > <= < == !=

import type { AnswerJSON, Question, Threshold } from "./types";

export type Node =
  | { k: "or" | "and"; a: Node; b: Node }
  | { k: "not"; a: Node }
  | { k: "cmp"; qid: string; option: string | null; op: string; value: number | string };

type Tok = { t: "op" | "str" | "num" | "id"; v: string };

const TOKEN = /\s*(?:(\|\||&&|>=|<=|==|!=|[><!().])|('[^']*'|"[^"]*")|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const s = src.trimEnd();
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m || TOKEN.lastIndex === start) throw new Error(`rule: unexpected text at ${s.slice(start, start + 20)}`);
    if (m[1]) out.push({ t: "op", v: m[1] });
    else if (m[2]) out.push({ t: "str", v: m[2].slice(1, -1) });
    else if (m[3]) out.push({ t: "num", v: m[3] });
    else out.push({ t: "id", v: m[4] });
  }
  return out;
}

export function parse(src: string, questions: Question[]): Node {
  const qs = new Map(questions.map((q) => [q.id, q]));
  const toks = tokenize(src);
  let i = 0;
  const peek = (v: string) => i < toks.length && toks[i].v === v && toks[i].t === "op";
  const take = () => {
    if (i >= toks.length) throw new Error("rule: unexpected end");
    return toks[i++];
  };
  const pOr = (): Node => {
    let n = pAnd();
    while (peek("||")) { take(); n = { k: "or", a: n, b: pAnd() }; }
    return n;
  };
  const pAnd = (): Node => {
    let n = pNot();
    while (peek("&&")) { take(); n = { k: "and", a: n, b: pNot() }; }
    return n;
  };
  const pNot = (): Node => {
    if (peek("!")) { take(); return { k: "not", a: pNot() }; }
    if (peek("(")) {
      take();
      const n = pOr();
      if (take().v !== ")") throw new Error("rule: expected )");
      return n;
    }
    return pCmp();
  };
  const pCmp = (): Node => {
    const id = take();
    const q = qs.get(id.v);
    if (id.t !== "id" || !q) throw new Error(`rule: unknown question ${id.v}`);
    let option: string | null = null;
    if (peek(".")) {
      take();
      const o = take();
      if (!q.options.includes(o.v)) throw new Error(`rule: ${q.id} has no option ${o.v}`);
      option = o.v;
    }
    const op = take();
    if (op.t !== "op" || ![">=", ">", "<=", "<", "==", "!="].includes(op.v)) throw new Error(`rule: bad operator ${op.v}`);
    const val = take();
    if (val.t === "num") return { k: "cmp", qid: q.id, option, op: op.v, value: Number(val.v) };
    if (val.t === "str") return { k: "cmp", qid: q.id, option, op: op.v, value: val.v };
    throw new Error(`rule: bad value ${val.v}`);
  };
  const tree = pOr();
  if (i !== toks.length) throw new Error(`rule: trailing tokens from ${toks[i].v}`);
  return tree;
}

export function refValue(a: AnswerJSON, q: Question, option: string | null): number | string {
  if (option !== null) return a.probs[option];
  if (q.kind === "probability") return a.probs.yes;
  if (q.kind === "score") return a.expected ?? NaN;
  return Object.entries(a.probs).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

export function evaluate(n: Node, answers: Record<string, AnswerJSON>, questions: Question[]): boolean {
  switch (n.k) {
    case "or": return evaluate(n.a, answers, questions) || evaluate(n.b, answers, questions);
    case "and": return evaluate(n.a, answers, questions) && evaluate(n.b, answers, questions);
    case "not": return !evaluate(n.a, answers, questions);
    case "cmp": {
      const a = answers[n.qid];
      if (!a || a.refused) return false;
      const x = refValue(a, questions.find((q) => q.id === n.qid)!, n.option);
      const v = n.value;
      switch (n.op) {
        case ">=": return (x as number) >= (v as number);
        case ">": return (x as number) > (v as number);
        case "<=": return (x as number) <= (v as number);
        case "<": return (x as number) < (v as number);
        case "==": return x === v;
        default: return x !== v;
      }
    }
  }
}

export function thresholdHit(t: Threshold, v: number | null): boolean {
  if (v === null) return false;
  return t.op === ">" ? v > t.value : t.op === ">=" ? v >= t.value : t.op === "<" ? v < t.value : v <= t.value;
}

/** Indices where the condition fires: true, and nothing fired in the previous `minutes`. */
export function cooldown(flags: boolean[], t: string[], minutes: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  flags.forEach((f, i) => {
    const ms = Date.parse(t[i]);
    if (f && ms - last >= minutes * 60_000) {
      out.push(i);
      last = ms;
    }
  });
  return out;
}

export type Cmp = Extract<Node, { k: "cmp" }>;

/** Every comparison in the rule, left to right. */
export function leaves(n: Node): Cmp[] {
  if (n.k === "cmp") return [n];
  if (n.k === "not") return leaves(n.a);
  return [...leaves(n.a), ...leaves(n.b)];
}

const SYMBOL: Record<string, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=", "!=": "≠" };

/** One comparison in words: "yes ≥ 70%", "“scarcity approaching” ≥ 60%", "top answer ≠ “nothing unusual”". */
export function describeLeaf(c: Cmp, q: Question): string {
  const subject = c.option !== null ? `“${c.option}”` : q.kind === "probability" ? "yes" : q.kind === "score" ? "level" : "top answer";
  const value = typeof c.value === "string" ? `“${c.value}”`
    : q.kind === "score" && c.option === null ? String(c.value) : `${Math.round(c.value * 100)}%`;
  return `${subject} ${SYMBOL[c.op] ?? c.op} ${value}`;
}

/** Numeric cutoffs the rule applies to a question's main value (e.g. P(yes) >= 0.6), for drawing. */
export function cutoffs(n: Node, qid: string, option: string | null = null): number[] {
  if (n.k === "cmp") return n.qid === qid && n.option === option && typeof n.value === "number" ? [n.value] : [];
  if (n.k === "not") return cutoffs(n.a, qid, option);
  return [...cutoffs(n.a, qid, option), ...cutoffs(n.b, qid, option)];
}
