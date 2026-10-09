// Saved example runs for the "Try it" page: each suggested week's example alert, run with the same code
// the page runs in the browser (src/explore/run.ts), written to public/explore/runs/<week>.json. The
// page shows them until a visitor runs their own alert.
// Every request is cached in ../data/cache/luna-web/, keyed by the request, so a re-run replays the
// same answers and spends nothing.
// Run: node scripts/save_runs.ts   (needs OPENAI_API_KEY or OPEN_AI_KEY in ../.env)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Hourly } from "../src/explore/data.ts";
import { describe, type Cache } from "../src/explore/openai.ts";
import { runWeek } from "../src/explore/run.ts";

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
  async get(k) {
    return existsSync(file(k)) ? JSON.parse(readFileSync(file(k), "utf8")) : undefined;
  },
  async set(k, value) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file(k), JSON.stringify(value));
  },
};

const data: Hourly = JSON.parse(readFileSync(new URL("../public/explore/ercot_hourly.json", import.meta.url), "utf8"));
const outDir = new URL("../public/explore/runs/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const week of data.weeks) {
  try {
    const run = await runWeek({ key, cache }, data, week.start, week.example);
    const out = new URL(`${week.start}.json`, outDir);
    // Keep the old file (and its date) when a cached re-run reproduces it exactly.
    const old = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    if (old && JSON.stringify({ ...old, created: "" }) === JSON.stringify({ ...run, created: "" })) {
      console.log(`same  ${week.start}`);
      continue;
    }
    writeFileSync(out, JSON.stringify(run) + "\n");
    const hours = run.rule_true.filter(Boolean).length;
    console.log(`saved ${week.start}  ${run.compiled.rule}  ->  rule met in ${hours} of ${run.rule_true.length} hours, ` +
      `${run.stats!.input_tokens} input tokens, $${run.stats!.cost_usd}, ${run.compiled.attempts.length} compile attempt(s)`);
  } catch (e) {
    console.error(`FAIL  ${week.start}: ${describe(e)}`);
    process.exitCode = 1;
  }
}
