// Checks that the TypeScript compose step (src/rule.ts) reproduces the firings the Python pipeline
// wrote, for every demo file: rule truth at every interval, threshold truth, and both firing lists.
// Also checks every saved "Try it" run: its alert hours follow from its answers and its rule.
// Run: npm run check-rules   (Node >= 22.6 strips the types itself)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cooldown, evaluate, parse, thresholdHit } from "../src/rule.ts";

const dir = new URL("../public/demo/", import.meta.url);
let failed = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "index.json")) {
  const d = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  const tree = parse(d.alert.rule, d.alert.questions);
  const ruleTrue = d.decisions.map((a: never) => evaluate(tree, a, d.alert.questions));
  const thrTrue = d.series[d.alert.baseline_threshold.series].map((v: number | null) => thresholdHit(d.alert.baseline_threshold, v));
  const checks = {
    rule_true: JSON.stringify(ruleTrue) === JSON.stringify(d.rule_true),
    threshold_true: JSON.stringify(thrTrue) === JSON.stringify(d.threshold_true),
    semantic_fired: JSON.stringify(cooldown(ruleTrue, d.t, d.cooldown_minutes)) === JSON.stringify(d.fired.semantic),
    threshold_fired: JSON.stringify(cooldown(thrTrue, d.t, d.cooldown_minutes)) === JSON.stringify(d.fired.threshold),
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${f}`, ok ? "" : checks);
}

const runs = new URL("../public/explore/runs/", import.meta.url);
for (const f of existsSync(runs) ? readdirSync(runs).filter((n) => n.endsWith(".json")) : []) {
  const r = JSON.parse(readFileSync(new URL(f, runs), "utf8"));
  const tree = parse(r.compiled.rule, r.compiled.questions);
  const ok = r.answers.every((a: never, k: number) => evaluate(tree, a, r.compiled.questions) === r.rule_true[k]);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} explore/runs/${f}`);
}
process.exit(failed ? 1 : 0);
