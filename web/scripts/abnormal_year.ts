// How often the demo's alert would actually fire: the same question as scripts/abnormal_run.ts, asked by
// gpt-6-luna's Decisions API about every hourly snapshot in the dataset (Dec 5, 2025 – Oct 8, 2026). The hours
// it judges abnormal are grouped into episodes (one notification each), and the count is scaled to a year, for
// the cost step's write-up estimate (src/Wrap.tsx). Written to public/demo/abnormal_year.json. Requests are
// cached in ../data/cache/luna-web/ (shared with abnormal_run.ts), so a re-run spends nothing.
// Run: node scripts/abnormal_year.ts   (needs OPENAI_API_KEY or OPEN_AI_KEY in ../.env)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Question } from "../src/types.ts";
import type { Hourly } from "../src/explore/data.ts";
import { MODEL, USD_PER_M_INPUT, decide, describe, pool, type Cache } from "../src/explore/openai.ts";
import { snapshot } from "../src/explore/snapshot.ts";

// Must match scripts/abnormal_run.ts exactly, so the test week's answers come from the same requests.
const QUESTION: Question = {
  id: "abnormal",
  kind: "choice",
  text: "Taking everything in this snapshot together, is ERCOT doing something abnormal right now, compared with what is normal for this time of day and season?",
  options: ["abnormal", "not_abnormal"],
};
const CUTOFF = 0.5;

const root = new URL("../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env", root), "utf8").split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2]]),
);
const key = env.OPENAI_API_KEY || env.OPEN_AI_KEY;
if (!key) throw new Error("OPENAI_API_KEY (or OPEN_AI_KEY) missing from .env");
const cacheDir = new URL("data/cache/luna-web/", root);
const file = (k: string) => new URL(`${createHash("sha256").update(k).digest("hex").slice(0, 24)}.json`, cacheDir);
const cache: Cache = {
  async get(k) { return existsSync(file(k)) ? JSON.parse(readFileSync(file(k), "utf8")) : undefined; },
  async set(k, value) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file(k), JSON.stringify(value)); },
};

const data: Hourly = JSON.parse(readFileSync(new URL("../public/explore/ercot_hourly.json", import.meta.url), "utf8"));
const first = data.days[0].first_hour;
const last = data.days[data.days.length - 1];
const n = last.first_hour + last.hours - first;

try {
  let tokens = 0, done = 0;
  const p = await pool(n, 8, async (k) => {
    const d = await decide({ key, cache }, snapshot(data, first + k), [QUESTION]);
    tokens += d.inputTokens;
    if (++done % 500 === 0) console.log(`  ${done} / ${n}`);
    const a = d.answers[QUESTION.id];
    return a.refused ? null : a.probs.abnormal;
  });
  // Episodes: runs of consecutive abnormal hours, one notification each.
  let episodes = 0, hours = 0;
  p.forEach((x, k) => {
    if (x === null || x < CUTOFF) return;
    hours++;
    if (k === 0 || p[k - 1] === null || p[k - 1]! < CUTOFF) episodes++;
  });
  const days = data.days.length;
  const out = {
    question: QUESTION, cutoff: CUTOFF, from: data.range.first_day, to: data.range.last_day, days, hours: n,
    abnormal_hours: hours, episodes, episodes_per_year: Math.round((episodes / days) * 365),
    refusals: p.filter((x) => x === null).length, input_tokens: tokens,
    cost_usd: Math.round((tokens / 1e6) * USD_PER_M_INPUT * 1e4) / 1e4, model: MODEL, created: new Date().toISOString(),
  };
  writeFileSync(new URL("../public/demo/abnormal_year.json", import.meta.url), JSON.stringify(out) + "\n");
  console.log(`saved: ${hours} abnormal hours of ${n} in ${episodes} episodes over ${days} days -> ~${out.episodes_per_year} a year; ${tokens} input tokens, $${out.cost_usd}`);
} catch (e) {
  console.error(`FAIL: ${describe(e)}`);
  process.exitCode = 1;
}
