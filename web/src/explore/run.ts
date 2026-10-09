// One week's run: compile the alert (unless it's already compiled), answer every hour's snapshot with
// the Decisions API, and decide each hour with the compiled rule in plain code. The page runs this
// in the browser; scripts/save_runs.ts runs the same code in Node for the saved example runs.

import { evaluate, parse } from "../rule.ts";
import type { AnswerJSON } from "../types.ts";
import { compileAlert, type Compiled } from "./compile.ts";
import { weekOf, type Hourly } from "./data.ts";
import { MODEL, USD_PER_M_INPUT, decide, pool, type Client } from "./openai.ts";
import { snapshot } from "./snapshot.ts";

export const CONCURRENCY = 8;

export interface RunStats {
  calls: number;
  input_tokens: number;
  cost_usd: number;
  latency_ms: { median: number; p95: number };
  refusals: number;
  concurrency: number;
}

export interface WeekRun {
  sentence: string;
  week: string; // first day, YYYY-MM-DD (Central)
  from: number; // hours [from, to) of ercot_hourly.json
  to: number;
  compiled: Compiled;
  prose: string[]; // what the model read, hour by hour
  answers: (Record<string, AnswerJSON> | null)[]; // null until answered
  rule_true: boolean[];
  stats: RunStats | null; // null until the run finishes
  model: string;
  created: string;
}

export type Progress = { phase: "compiling"; attempt: number } | { phase: "deciding"; run: WeekRun; done: number };

function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * q;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

export async function runWeek(c: Client, data: Hourly, start: string, sentence: string,
  opts: { compiled?: Compiled; onProgress?: (p: Progress) => void } = {}): Promise<WeekRun> {
  const { onProgress } = opts;
  const compiled = opts.compiled ?? (await compileAlert(c, sentence, (attempt) => onProgress?.({ phase: "compiling", attempt })));
  const tree = parse(compiled.rule, compiled.questions);
  const w = weekOf(data, start);
  const n = w.to - w.from;
  const run: WeekRun = {
    sentence, week: w.start, from: w.from, to: w.to, compiled,
    prose: Array.from({ length: n }, (_, k) => snapshot(data, w.from + k)),
    answers: new Array(n).fill(null), rule_true: new Array(n).fill(false),
    stats: null, model: MODEL, created: "",
  };
  const latency: number[] = [];
  let tokens = 0;
  let done = 0;
  onProgress?.({ phase: "deciding", run, done });
  // The first error that survives retries (a bad key, no quota) stops every request still in flight.
  const stop = new AbortController();
  c.signal?.addEventListener("abort", () => stop.abort(c.signal?.reason), { once: true });
  const inner = { ...c, signal: stop.signal };
  try {
    await pool(n, CONCURRENCY, async (k) => {
      const d = await decide(inner, run.prose[k], compiled.questions);
      run.answers[k] = d.answers;
      run.rule_true[k] = evaluate(tree, d.answers, compiled.questions);
      latency.push(d.ms);
      tokens += d.inputTokens;
      onProgress?.({ phase: "deciding", run, done: ++done });
    });
  } catch (e) {
    stop.abort(e);
    throw e;
  }
  run.stats = {
    calls: n,
    input_tokens: tokens,
    cost_usd: Math.round((tokens / 1e6) * USD_PER_M_INPUT * 1e5) / 1e5,
    latency_ms: { median: Math.round(pct(latency, 0.5)), p95: Math.round(pct(latency, 0.95)) },
    refusals: run.answers.reduce((s, a) => s + Object.values(a ?? {}).filter((x) => x.refused).length, 0),
    concurrency: CONCURRENCY,
  };
  run.created = new Date().toISOString();
  return run;
}
