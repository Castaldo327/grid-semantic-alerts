// The demo's test run (src/Results.tsx): the alert "Tell me whenever ERCOT is doing something abnormal" on
// the heat-wave week, Aug 20–26, 2026. gpt-6-luna's Decisions API judges every hourly snapshot abnormal or
// not_abnormal; the hours it judges abnormal are grouped into episodes, and the Responses API writes the
// notification each episode would send, then a digest of the week from those notifications.
// It also checks the week's flagged readings (each day's tags: crossings of fixed alert lines like demand at or
// above 90 GW) against the 30 days before the week. A reading of the grid's behavior (prices, reserves, demand)
// is a verified grid abnormality only if it is more extreme than anything in that month, and caught if the
// model judged its hour abnormal. Weather readings (temperature) are the grid's input, not its behavior: a
// record is noted as a weather record but not scored, since the alert asks about the grid.
// Written to public/demo/abnormal_2026-08-20.json. Requests are cached in ../data/cache/luna-web/, so a
// re-run replays the same answers and spends nothing.
// Run: node scripts/abnormal_run.ts   (needs OPENAI_API_KEY or OPEN_AI_KEY in ../.env)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Question } from "../src/types.ts";
import { dayLabel, hourLabel, weekOf, type Hourly } from "../src/explore/data.ts";
import { MODEL, USD_PER_M_INPUT, decide, describe, generate, pool, type Cache } from "../src/explore/openai.ts";
import { snapshot } from "../src/explore/snapshot.ts";

const START = "2026-08-20";
const ALERT = "Tell me whenever ERCOT is doing something abnormal";
const QUESTION: Question = {
  id: "abnormal",
  kind: "choice",
  text: "Taking everything in this snapshot together, is ERCOT doing something abnormal right now, compared with what is normal for this time of day and season?",
  options: ["abnormal", "not_abnormal"],
};
const CUTOFF = 0.5; // an hour is abnormal when the model puts more weight on abnormal than not

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
const c = { key, cache };

const data: Hourly = JSON.parse(readFileSync(new URL("../public/explore/ercot_hourly.json", import.meta.url), "utf8"));
const w = weekOf(data, START);
const n = w.to - w.from;
const prose = Array.from({ length: n }, (_, k) => snapshot(data, w.from + k));
const when = (k: number) => {
  const day = w.days.find((x) => w.from + k < x.first_hour + x.hours)!;
  return `${dayLabel(day.date, { weekday: "short", month: "short", day: "numeric" })}, ${hourLabel(data, w.from + k)}`;
};

try {
  // 1. Every hour, judged.
  const latency: number[] = [];
  let tokens = 0, refusals = 0;
  const p = await pool(n, 8, async (k) => {
    const d = await decide(c, prose[k], [QUESTION]);
    latency.push(d.ms);
    tokens += d.inputTokens;
    const a = d.answers[QUESTION.id];
    if (a.refused) { refusals++; return null; }
    return a.probs.abnormal;
  });
  const sorted = [...latency].sort((a, b) => a - b);

  // 2. Abnormal hours grouped into episodes (runs of consecutive hours), each written up as a notification.
  const episodes: { from: number; to: number }[] = [];
  p.forEach((x, k) => {
    if (x === null || x < CUTOFF) return;
    const last = episodes[episodes.length - 1];
    if (last && last.to === k - 1) last.to = k;
    else episodes.push({ from: k, to: k });
  });
  const notes = [];
  const written = { calls: 0, input_tokens: 0, output_tokens: 0 };
  for (const e of episodes) {
    const hours = Array.from({ length: e.to - e.from + 1 }, (_, j) => e.from + j);
    const { text, usage } = await generate(c, [
      { role: "system", content: `You write the notification a Grid Status user receives when their alert fires. Their alert: "${ALERT}". A fast classifier judged the hours below abnormal. Using only facts stated in the snapshots, reply with JSON: {"headline": "at most 8 words", "summary": "one or two plain sentences: what was abnormal, with the key numbers"}. Do not guess at causes the snapshots don't state.` },
      { role: "user", content: hours.map((k) => `[${when(k)}, P(abnormal) = ${Math.round((p[k] ?? 0) * 100)}%]\n${prose[k]}`).join("\n\n") },
    ]);
    written.calls++; written.input_tokens += usage.input; written.output_tokens += usage.output;
    const out = JSON.parse(text) as { headline: string; summary: string };
    const peak = hours.reduce((b, k) => ((p[k] ?? 0) > (p[b] ?? 0) ? k : b), hours[0]);
    notes.push({ from: e.from, to: e.to, at: when(e.from), peak, p: p[peak], headline: out.headline, summary: out.summary });
    console.log(`  ${when(e.from)} (${hours.length}h): ${out.headline}`);
  }

  // 3. The week's alert-line crossings, verified against the month before the week (no model involved).
  const SERIES: Record<string, { key: keyof Hourly["series"]; low: boolean }> = {
    demand: { key: "load_max", low: false }, heat: { key: "temp", low: false }, price: { key: "hub_max", low: false },
    reserve_price: { key: "nspin_max", low: false }, reserves: { key: "prc_min", low: true },
  };
  const readings = w.days.flatMap((day, j) => day.tags.map((t) => {
    const m = /around (\d{1,2}) (AM|PM)/.exec(t.text)!;
    const k = j * 24 + (Number(m[1]) % 12) + (m[2] === "PM" ? 12 : 0);
    const { key: sk, low } = SERIES[t.kind];
    const before = data.series[sk].slice(w.from - 720, w.from).filter((v): v is number => v !== null);
    const baseline = low ? Math.min(...before) : Math.max(...before);
    const value = data.series[sk][w.from + k]!;
    const beyond = low ? value < baseline : value > baseline;
    const weather = t.kind === "heat" || t.kind === "freeze";
    return { date: day.date, kind: t.kind, text: t.text, k, value, baseline, beyond, weather, verified: beyond && !weather, p: p[k], caught: (p[k] ?? 0) >= CUTOFF };
  }));
  const verified = readings.filter((r) => r.verified);
  console.log(`readings: ${readings.length} crossings, ${verified.length} verified grid abnormalities, ${verified.filter((r) => r.caught).length} caught, ${readings.filter((r) => r.weather && r.beyond).length} weather records`);
  for (const r of readings) console.log(`  ${r.verified ? "VERIFIED" : r.weather && r.beyond ? "weather " : "routine "} ${r.caught ? "caught" : "      "} p=${(r.p ?? 0).toFixed(2)}  ${r.date} ${r.text}  (month before: ${Math.round(r.baseline)})`);

  // 4. The positive summaries, passed back for a digest of the week.
  const { text: digestText, usage: digestUsage } = await generate(c, [
    { role: "system", content: `You write a weekly digest for a Grid Status user whose alert is "${ALERT}". Below are the notifications it sent this week. Using only those, reply with JSON: {"digest": "two or three plain sentences: what kind of week it was and the moments that stood out, with key numbers"}.` },
    { role: "user", content: notes.map((x) => `${x.at}: ${x.headline}. ${x.summary}`).join("\n") },
  ]);
  const digest = (JSON.parse(digestText) as { digest: string }).digest;

  const out = {
    alert: ALERT, question: QUESTION, week: w.start, from: w.from, to: w.to, cutoff: CUTOFF,
    p, episodes: notes, digest, readings,
    baseline: { from: w.from - 720, to: w.from, note: "the 30 days before the week" },
    stats: {
      calls: n, input_tokens: tokens, cost_usd: Math.round((tokens / 1e6) * USD_PER_M_INPUT * 1e5) / 1e5,
      latency_ms: { median: sorted[Math.floor(n / 2)], p95: sorted[Math.floor(n * 0.95)] }, refusals,
      notifications: written, digest: { input_tokens: digestUsage.input, output_tokens: digestUsage.output },
    },
    model: MODEL, created: new Date().toISOString(),
  };
  mkdirSync(new URL("../public/demo/", import.meta.url), { recursive: true });
  writeFileSync(new URL(`../public/demo/abnormal_${START}.json`, import.meta.url), JSON.stringify(out) + "\n");
  const flagged = p.filter((x) => x !== null && x >= CUTOFF).length;
  console.log(`saved: ${flagged} of ${n} hours abnormal in ${notes.length} episodes, ${tokens} input tokens, $${out.stats.cost_usd}, median ${out.stats.latency_ms.median} ms`);
  console.log(`digest: ${digest}`);
} catch (e) {
  console.error(`FAIL: ${describe(e)}`);
  process.exitCode = 1;
}
