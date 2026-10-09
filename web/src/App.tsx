import { useEffect, useMemo, useState } from "react";
import { LinePanel, clock, makeX, useWidth, type Series } from "./chart";
import { Lanes, WhatIf, ruleLines } from "./lanes";
import { cooldown, evaluate, parse, refValue, thresholdHit, type Node } from "./rule";
import type { Demo, IndexEntry, Question } from "./types";
import { LiveBox } from "./live";

const TABS: Record<string, { label: string; date: string; context: string; notes: string[] }> = {
  record_load: {
    label: "Record load, no scarcity",
    date: "Jul 22, 2026",
    context:
      "ERCOT set an all-time demand record of 91,308 MW at 4:55 PM. Batteries kept real-time prices low through the " +
      "afternoon; reserves only tightened after sunset, as solar fell and battery discharge came off its peak.",
    notes: [
      "The threshold fired every 30 minutes from 2:55 PM to 6:25 PM, while operating reserves (PRC) sat between 16.5 and 17.7 GW and the hub price stayed under $82/MWh.",
      "The semantic alert stayed quiet through the record afternoon (scarcity probability 0.14 to 0.26 at the threshold's firings) and fired 4 times between 8:10 PM and 10:25 PM, as reserves fell from 9.2 GW to 6.6 GW and non-spinning reserve reached $187/MWh.",
      "The contrast question did not separate the record from scarcity: it picked \u201cscarcity approaching\u201d at all 8 threshold firings. The main question carried the decision.",
      "It is borderline: the firings sit at 0.70 to 0.73 against a 0.7 cutoff, and from 8:15 to 9:15 PM the probability hovered just under it. An earlier compile of the same sentence chose a 0.6 cutoff and fired 7 times, including a questionable 7:00 AM alarm.",
    ],
  },
  local_spike: {
    label: "Local spike, not system-wide",
    date: "Feb 19, 2025",
    context:
      "The Rabbit Hill battery node (RHESS2_ESS1) reached $28,401/MWh at 8:10 AM from congestion around Austin while the " +
      "ERCOT hub average was $162/MWh. Reserves never fell below 8.2 GW.",
    notes: [
      "The node was above $5,000/MWh for 113 five-minute intervals; the hub average peaked at $469/MWh for the whole day.",
      "The semantic alert never fired. Its main question (are prices spiking because the whole grid is short?) never went above 0.18.",
      "Caveat: the driver question answered \u201cone-area congestion\u201d at all 288 intervals, including the 65 when the node was under $100. Constraints were binding statewide all day, so it is not wrong, but it is not discriminating either.",
    ],
  },
};

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem("theme") as Theme) || "system"; } catch { return "system"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const next = () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"));
  return [theme, next];
}

const gw = (v: number) => `${(v / 1000).toFixed(1)} GW`;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const gwTick = (v: number) => `${Math.round(v / 1000)}`;
const usdTick = (v: number) => (v >= 1000 ? `${v / 1000}k` : `${v}`);

function contextPanels(d: Demo): { title: string; series: Series[]; log?: boolean; yFmt: (v: number) => string; zero?: boolean }[] {
  const s = d.series;
  const coarse = (k: string) => (d.scenario.coarse_series.includes(k) ? "hourly, forward-filled" : undefined);
  if (d.scenario.scenario === "record_load") {
    return [
      { title: "Demand, GW", yFmt: gwTick, zero: false, series: [
        { key: "load_mw", label: "Load", color: "var(--s1)", values: s.load_mw, format: gw },
        { key: "load_forecast_mw", label: "Forecast", color: "var(--muted-series)", values: s.load_forecast_mw, format: gw, note: coarse("load_forecast_mw") },
        { key: "net_load_mw", label: "Net load", color: "var(--s2)", values: s.net_load_mw, format: gw },
      ] },
      { title: "Supply and reserves, GW", yFmt: gwTick, series: [
        { key: "solar_mw", label: "Solar", color: "var(--s4)", values: s.solar_mw, format: gw },
        { key: "battery_discharge_mw", label: "Battery discharge", color: "var(--s3)", values: s.battery_discharge_mw, format: gw },
        { key: "prc_mw", label: "Reserves (PRC)", color: "var(--s1)", values: s.prc_mw, format: gw },
      ] },
      { title: "Prices, $/MWh", yFmt: usdTick, series: [
        { key: "hub_rt_price", label: "Hub real-time", color: "var(--s1)", values: s.hub_rt_price, format: usd },
        { key: "hub_da_price", label: "Hub day-ahead", color: "var(--muted-series)", values: s.hub_da_price, format: usd, note: coarse("hub_da_price") },
        { key: "nspin_price", label: "Non-spin reserve", color: "var(--s2)", values: s.nspin_price, format: usd },
      ] },
    ];
  }
  return [
    { title: "Real-time prices, $/MWh (log scale)", log: true, yFmt: usdTick, series: [
      { key: "node_price", label: "Rabbit Hill node", color: "var(--s2)", values: s.node_price, format: usd },
      { key: "lcra_price", label: "LCRA zone", color: "var(--s3)", values: s.lcra_price, format: usd },
      { key: "hub_rt_price", label: "Hub average", color: "var(--s1)", values: s.hub_rt_price, format: usd },
    ] },
    { title: "Binding constraints, shadow price $/MWh", yFmt: usdTick, series: [
      { key: "max_shadow_price", label: "Highest, statewide", color: "var(--s1)", values: s.max_shadow_price, format: usd },
      { key: "near_node_shadow_price", label: "GEORSO line (near node)", color: "var(--s2)", values: s.near_node_shadow_price, format: usd },
    ] },
    { title: "Reserves (PRC), GW", yFmt: gwTick, series: [
      { key: "prc_mw", label: "Reserves (PRC)", color: "var(--s1)", values: s.prc_mw, format: gw },
    ] },
  ];
}

function RuleTrace({ n, d, i }: { n: Node; d: Demo; i: number }) {
  const qs = d.alert.questions;
  if (n.k === "not") return <><span className="op">!</span>(<RuleTrace n={n.a} d={d} i={i} />)</>;
  if (n.k !== "cmp")
    return <><RuleTrace n={n.a} d={d} i={i} /> <span className="op">{n.k === "and" ? "&&" : "||"}</span> <RuleTrace n={n.b} d={d} i={i} /></>;
  const q = qs.find((x) => x.id === n.qid)!;
  const v = refValue(d.decisions[i][n.qid], q, n.option);
  const ok = evaluate(n, d.decisions[i], qs);
  const ref = n.option ? `${n.qid}.'${n.option}'` : n.qid;
  const val = typeof n.value === "number" ? n.value : `'${n.value}'`;
  return (
    <span className={`clause ${ok ? "pass" : "fail"}`}>
      {ref} <span className="live">[{typeof v === "number" ? v.toFixed(2) : `'${v}'`}]</span> {n.op} {val}
      <span className="verdict" aria-label={ok ? "true" : "false"}>{ok ? " ✓" : " ✗"}</span>
    </span>
  );
}

function Bars({ q, a }: { q: Question; a: Demo["decisions"][number][string] }) {
  if (a.refused) return <p className="muted">Refused by the model.</p>;
  const top = Object.entries(a.probs).reduce((b, c) => (c[1] > b[1] ? c : b))[0];
  return (
    <div className="bars">
      {q.options.map((o) => {
        const p = a.probs[o] ?? 0;
        return (
          <div key={o} className={`bar-row${o === top ? " top" : ""}`}>
            <span className="bar-label">{o}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.max(p * 100, 0.5)}%` }} /></span>
            <span className="bar-value">{p.toFixed(2)}</span>
          </div>
        );
      })}
      {a.expected !== undefined && <div className="muted small">weighted score {a.expected.toFixed(2)}</div>}
    </div>
  );
}

function Scenario({ d, whatif }: { d: Demo; whatif?: Demo & { simulated: { label: string; method: string } } }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const X = useMemo(() => makeX(d.t, width), [d.t, width]);
  const tree = useMemo(() => parse(d.alert.rule, d.alert.questions), [d]);
  // Compose in the browser: rule + threshold + cooldown, from the decision JSON alone.
  const ruleTrue = useMemo(() => d.decisions.map((a) => evaluate(tree, a, d.alert.questions)), [d, tree]);
  const thrTrue = useMemo(() => d.series[d.alert.baseline_threshold.series].map((v) => thresholdHit(d.alert.baseline_threshold, v)), [d]);
  const semFired = useMemo(() => cooldown(ruleTrue, d.t, d.cooldown_minutes), [ruleTrue, d]);
  const thrFired = useMemo(() => cooldown(thrTrue, d.t, d.cooldown_minutes), [thrTrue, d]);
  const parity =
    JSON.stringify(semFired) === JSON.stringify(d.fired.semantic) &&
    JSON.stringify(thrFired) === JSON.stringify(d.fired.threshold) &&
    JSON.stringify(ruleTrue) === JSON.stringify(d.rule_true);
  const lines = useMemo(() => ruleLines(d, tree), [d, tree]);
  const panels = useMemo(() => contextPanels(d), [d]);
  const firstInteresting = semFired[0] ?? thrFired[0] ?? 0;
  const [idx, setIdx] = useState(firstInteresting);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => { setIdx(semFired.find((i) => i > 100) ?? thrFired[0] ?? 0); }, [d, semFired, thrFired]);
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const copy = TABS[d.scenario.scenario];
  const ex = d.explanations[d.t[idx]];
  const firedHere = [semFired.includes(idx) && "semantic", thrFired.includes(idx) && "threshold"].filter(Boolean);
  const events = [...new Set([...thrFired, ...semFired])].sort((a, b) => a - b);
  const jump = (dir: 1 | -1) => {
    const next = dir > 0 ? events.find((i) => i > idx) : [...events].reverse().find((i) => i < idx);
    if (next !== undefined) setIdx(next);
  };
  const compileErr = d.compile.errors.map((e) => (e.split("Value error, ")[1] ?? e).split(" [type=")[0]);

  return (
    <>
      <section className="intro">
        <blockquote className="sentence">“{d.alert.sentence}”</blockquote>
        <p className="context">{copy.context}</p>
      </section>

      <section className="compiled">
        <h2>Compiled into</h2>
        <p className="muted small">
          {d.compile.model.name} compiled the sentence once{d.compile.attempts > 1 ? `, in ${d.compile.attempts} attempts` : ""}.
          {compileErr.length > 0 && <> The validator rejected the first try: <em>{compileErr[0]}</em></>}
        </p>
        <pre className="code"><code>
{d.alert.questions.map((q) => (
  <span key={q.id} className="q">{`${q.kind.padEnd(11)} `}<span className="id">{q.id}</span>{`  "${q.text}"\n            [${q.options.map((o) => `'${o}'`).join(", ")}]\n`}</span>
))}
{"\n"}<span className="kw">rule</span>{`        ${d.alert.rule}\n`}
<span className="kw">cooldown</span>{`    ${d.cooldown_minutes} min\n`}
<span className="kw">baseline</span>{`    ${d.alert.baseline_threshold.series} ${d.alert.baseline_threshold.op} ${d.alert.baseline_threshold.value.toLocaleString("en-US")}   (today's threshold alert)`}
        </code></pre>
      </section>

      <section className="charts" ref={ref}>
        <h2>Grid context</h2>
        {panels.map((p) => (
          <LinePanel key={p.title} title={p.title} t={d.t} X={X} series={p.series} idx={idx} onIdx={setIdx}
            log={p.log} yFmt={p.yFmt} zero={p.zero} hidden={hidden} onToggle={toggle} />
        ))}
        {panels.some((p) => p.series.some((s) => s.note)) && <p className="muted small">* hourly series, forward-filled to 5 minutes.</p>}
        <h2>Alert lanes</h2>
        <Lanes d={d} X={X} idx={idx} onIdx={setIdx} ruleTrue={ruleTrue} semFired={semFired} thrFired={thrFired} lines={lines} />
        {whatif && <>
          <h2>What if 8 GW of batteries had been offline?</h2>
          <WhatIf real={d} sim={whatif} X={X} idx={idx} onIdx={setIdx} />
          <p className="muted small">Simulated prose at {clock(d.t[idx])}: {whatif.prose[idx]}</p>
        </>}
      </section>

      <section className="scrubber" aria-label="Time scrubber">
        <button type="button" onClick={() => jump(-1)} aria-label="Previous firing">‹ firing</button>
        <input type="range" min={0} max={d.t.length - 1} value={idx} onChange={(e) => setIdx(Number(e.target.value))}
          aria-label="Interval" aria-valuetext={clock(d.t[idx])} />
        <button type="button" onClick={() => jump(1)} aria-label="Next firing">firing ›</button>
        <span className="now">{clock(d.t[idx])} CT</span>
      </section>

      <section className="detail">
        <div className="detail-state">
          <h2>What {d.model.name} saw at {clock(d.t[idx])}</h2>
          <p className="prose">{d.prose[idx]}</p>
          <div className="fired-tags">
            {firedHere.length === 0 && <span className="tag">no firing here</span>}
            {firedHere.map((f) => <span key={f as string} className={`tag ${f === "semantic" ? "sem" : "thr"}`}>{f} alert fired</span>)}
            {firedHere.length === 0 && d.threshold_true[idx] && <span className="tag">threshold true (in cooldown)</span>}
          </div>
          {ex && (
            <div className={`explain ${ex.kind}`}>
              <div className="explain-head">
                {ex.kind === "fired" ? "Why it fired" : "Why the semantic alert declined this threshold firing"}
                <span className="muted small"> · written by {d.explained_by.name}{ex.checked ? ", numbers checked against the state" : ", FAILED the numbers check"}</span>
              </div>
              <p>{ex.text}</p>
            </div>
          )}
        </div>
        <div className="detail-answers">
          <h2>Decisions API answers <span className="muted small">· {d.decision_latency_ms[idx].toFixed(0)} ms</span></h2>
          {d.alert.questions.map((q) => (
            <div key={q.id} className="question">
              <div className="q-text"><span className="kind">{q.kind}</span> {q.text}</div>
              <Bars q={q} a={d.decisions[idx][q.id]} />
            </div>
          ))}
          <div className="trace">
            <div className="muted small">Rule, evaluated in your browser:</div>
            <code><RuleTrace n={tree} d={d} i={idx} /></code>
            <div className={`rule-result ${ruleTrue[idx] ? "pass" : "fail"}`}>{ruleTrue[idx] ? "true" : "false"}</div>
          </div>
        </div>
      </section>

      <section className="summary">
        <div className="stat"><span className="stat-label"><span className="mark thr" /> Threshold firings</span><span className="stat-value">{thrFired.length}</span></div>
        <div className="stat"><span className="stat-label"><span className="mark sem" /> Semantic firings</span><span className="stat-value">{semFired.length}</span></div>
        <ul className="notes">{copy.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="small">
          <a href={d.scenario.blog_url} target="_blank" rel="noreferrer">Grid Status blog post on this day ↗</a>
          <span className="muted"> · </span>
          <span className={parity ? "ok" : "bad"}>
            {parity ? "Firings recomputed in your browser match the precomputed run." : "Browser recompute does NOT match the precomputed firings."}
          </span>
        </p>
      </section>
      {import.meta.env.VITE_LIVE_API && <LiveBox scenario={d.scenario.scenario} />}
    </>
  );
}

export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [demos, setDemos] = useState<Record<string, Demo>>({});
  const [whatifs, setWhatifs] = useState<Record<string, Demo & { simulated: { label: string; method: string } }>>({});
  const [tab, setTabState] = useState<string>(() => (location.hash.slice(1) in TABS ? location.hash.slice(1) : "record_load"));
  const setTab = (k: string) => { setTabState(k); history.replaceState(null, "", `#${k}`); };
  const [err, setErr] = useState<string | null>(null);
  const [theme, nextTheme] = useTheme();

  useEffect(() => {
    fetch("demo/index.json").then((r) => r.json()).then(async (idx: IndexEntry[]) => {
      setIndex(idx);
      const all = await Promise.all(idx.map((e) => fetch(e.file).then((r) => r.json() as Promise<Demo>)));
      setDemos(Object.fromEntries(all.map((d) => [d.scenario.scenario, d])));
      // Simulated runs live in their own files (whatif_<alert_id>.json); missing is fine.
      const sims = await Promise.all(idx.map((e) => fetch(`demo/whatif_${e.alert_id}.json`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      setWhatifs(Object.fromEntries(sims.filter(Boolean).map((s) => [s.scenario.scenario, s])));
    }).catch((e) => setErr(String(e)));
  }, []);

  const d = demos[tab];
  const allStats = Object.values(demos).map((x) => x.decision_stats);
  const decisions = allStats.reduce((s, x) => s + x.decisions, 0);

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Alerts written as sentences, decided by a model that never writes a word.</h1>
          <p className="muted">
            A concept for semantic alerts on ERCOT data: gpt-6-luna compiles a plain-English alert into typed questions once,
            the Decisions API answers them against every 5-minute grid snapshot, and plain TypeScript decides whether to fire.
          </p>
        </div>
        <button type="button" className="theme" onClick={nextTheme} aria-label={`Theme: ${theme}`}>{theme === "system" ? "◐ auto" : theme === "light" ? "○ light" : "● dark"}</button>
      </header>

      <nav className="tabs" role="tablist">
        {Object.entries(TABS).map(([k, v]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            <span>{v.label}</span> <span className="muted">({v.date})</span>
          </button>
        ))}
      </nav>

      {err && <p className="bad">Could not load demo data: {err}</p>}
      {!d && !err && <p className="muted">Loading precomputed run…</p>}
      {d && <Scenario key={tab} d={d} whatif={whatifs[tab]} />}

      <footer>
        {index && allStats.length === index.length && (
          <p>
            <b>{decisions.toLocaleString("en-US")}</b> decisions by <b>gpt-6-luna</b> (OpenAI Decisions API, public beta), one request
            per snapshot with all of an alert's questions.
            Measured latency per request: {Object.values(demos).map((x) => (
              <span key={x.alert.alert_id}> {TABS[x.scenario.scenario].date}: median <b>{x.decision_stats.latency_ms.median.toFixed(0)} ms</b>, p95 <b>{x.decision_stats.latency_ms.p95.toFixed(0)} ms</b>;</span>
            ))} {allStats[0].measured_on}. Token cost for the whole run: ${allStats.reduce((s, x) => s + x.cost_usd, 0).toFixed(3)}.
          </p>
        )}
        <p>
          Compiling and explanations: gpt-6-luna on the Responses API. All model outputs were precomputed locally and are replayed here;
          this page makes no API calls.
        </p>
        <p>
          Data: Grid Status API{d ? <> · {d.datasets.join(", ")} · {d.scenario.day}</> : null}. Times are US Central.
        </p>
        <p className="muted">Independent concept demo. Not affiliated with Grid Status.</p>
      </footer>
    </div>
  );
}
