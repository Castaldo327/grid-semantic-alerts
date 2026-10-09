import { useCallback, useEffect, useMemo, useState } from "react";
import { LinePanel, clock, makeX, useWidth, type Series } from "./chart";
import { WhatIf } from "./lanes";
import { LiveBox } from "./live";
import { cooldown, cutoffs, evaluate, parse, refValue, thresholdHit, type Node } from "./rule";
import { ProbChart, ThresholdChart } from "./story";
import type { Demo, IndexEntry, Question } from "./types";

type Sim = Demo & { simulated: { label: string; method: string } };

const gw = (v: number) => `${(v / 1000).toFixed(1)} GW`;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const gwTick = (v: number) => `${Math.round(v / 1000)} GW`;
const usdTick = (v: number) => (v >= 1000 ? `$${v / 1000}k` : `$${v}`);

interface Copy {
  tab: string;
  date: string;
  context: string;
  thrSummary: string;
  semSummary: string;
  watch: { title: string; series: { key: string; label: string; cls: string; fmt: (v: number) => string }[]; log?: boolean; tick: (v: number) => string; limitLabel: string };
  probTitle: string;
  reservesNote: string;
  readouts: { key: string; label: string; fmt: (v: number) => string }[];
  notes: string[];
}

const COPY: Record<string, Copy> = {
  record_load: {
    tab: "Record load, no scarcity",
    date: "Jul 22, 2026",
    context: "ERCOT set an all-time demand record (91.3 GW at 4:55 PM), but batteries kept prices low and reserves near 17 GW all afternoon. The grid only tightened after sunset.",
    thrSummary: "Fired all afternoon on record demand, while reserves sat near 17 GW and prices stayed under $82.",
    semSummary: "Stayed quiet through the record, then fired after 8 PM as reserves fell to 6.6 GW.",
    watch: { title: "ERCOT demand: what the threshold alert watches", tick: gwTick, limitLabel: "threshold: 90 GW",
      series: [{ key: "load_mw", label: "Demand", cls: "c1", fmt: gw }] },
    probTitle: "Semantic alert: gpt-6-luna's probability that ERCOT is heading toward scarcity",
    reservesNote: "Operating reserves (PRC): lower means a tighter grid",
    readouts: [
      { key: "load_mw", label: "Demand", fmt: gw },
      { key: "prc_mw", label: "Reserves", fmt: gw },
      { key: "hub_rt_price", label: "Hub price", fmt: (v) => `${usd(v)}/MWh` },
      { key: "battery_discharge_mw", label: "Batteries", fmt: gw },
    ],
    notes: [
      "The threshold fired every 30 minutes from 2:55 PM to 6:25 PM. Reserves were 16.5–17.7 GW and the hub price stayed under $82/MWh the whole time.",
      "The semantic alert's probability was 14–26% at each of those threshold alerts. It fired 4 times between 8:10 and 10:25 PM, as reserves fell from 9.2 to 6.6 GW and non-spinning reserve reached $187/MWh.",
      "Borderline: those firings sit at 70–73% against a 70% cutoff, and an earlier compile of the same sentence chose 60% and fired 7 times.",
      "The contrast question (“scarcity approaching” vs “demand record only”) picked scarcity at all 8 threshold alerts; the main question carried the decision.",
    ],
  },
  local_spike: {
    tab: "Local spike, not system-wide",
    date: "Feb 19, 2025",
    context: "The Rabbit Hill battery node hit $28,401/MWh at 8:10 AM from congestion near Austin, while the ERCOT hub average was $162 and reserves never fell below 8.2 GW.",
    thrSummary: "Fired 32 times on one congested battery node.",
    semSummary: "Never fired: the probability that the whole grid was short stayed under 19% all day.",
    watch: { title: "Rabbit Hill node vs. ERCOT hub price (log scale): the threshold watches the node", log: true, tick: usdTick, limitLabel: "threshold: $1,000/MWh",
      series: [
        { key: "node_price", label: "Rabbit Hill node", cls: "c2", fmt: (v) => `${usd(v)}/MWh` },
        { key: "hub_rt_price", label: "ERCOT hub average", cls: "c1", fmt: (v) => `${usd(v)}/MWh` },
      ] },
    probTitle: "Semantic alert: gpt-6-luna's probability that prices are spiking because the whole grid is short",
    reservesNote: "Operating reserves (PRC): never near emergency levels",
    readouts: [
      { key: "node_price", label: "Node", fmt: (v) => `${usd(v)}/MWh` },
      { key: "hub_rt_price", label: "Hub", fmt: (v) => `${usd(v)}/MWh` },
      { key: "lcra_price", label: "LCRA zone", fmt: (v) => `${usd(v)}/MWh` },
      { key: "prc_mw", label: "Reserves", fmt: gw },
    ],
    notes: [
      "The node was above $5,000/MWh for 113 five-minute intervals; the hub average never went above $469 all day.",
      "The semantic alert's main question never went above 18%, so it declined all 32 threshold alerts. Each declined alert has a note naming the binding constraint.",
      "Caveat: the cause question answered “one-area congestion” at every interval, including the 65 quiet ones when the node was under $100. Right answer, but not a discriminating one.",
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
  return [theme, () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))];
}

function contextPanels(d: Demo): { title: string; series: Series[]; log?: boolean; yFmt: (v: number) => string; zero?: boolean }[] {
  const s = d.series;
  const t = (v: number) => `${Math.round(v / 1000)}`;
  const p = (v: number) => (v >= 1000 ? `${v / 1000}k` : `${v}`);
  if (d.scenario.scenario === "record_load") {
    return [
      { title: "Demand, GW", yFmt: t, zero: false, series: [
        { key: "load_mw", label: "Load", color: "var(--s1)", values: s.load_mw, format: gw },
        { key: "load_forecast_mw", label: "Forecast (hourly)", color: "var(--muted-series)", values: s.load_forecast_mw, format: gw },
        { key: "net_load_mw", label: "Net load", color: "var(--s2)", values: s.net_load_mw, format: gw },
      ] },
      { title: "Supply, GW", yFmt: t, series: [
        { key: "solar_mw", label: "Solar", color: "var(--s4)", values: s.solar_mw, format: gw },
        { key: "battery_discharge_mw", label: "Battery discharge", color: "var(--s3)", values: s.battery_discharge_mw, format: gw },
      ] },
      { title: "Prices, $/MWh", yFmt: p, series: [
        { key: "hub_rt_price", label: "Hub real-time", color: "var(--s1)", values: s.hub_rt_price, format: usd },
        { key: "hub_da_price", label: "Hub day-ahead (hourly)", color: "var(--muted-series)", values: s.hub_da_price, format: usd },
        { key: "nspin_price", label: "Non-spin reserve", color: "var(--s2)", values: s.nspin_price, format: usd },
      ] },
    ];
  }
  return [
    { title: "LCRA load zone price, $/MWh (log)", log: true, yFmt: p, series: [
      { key: "lcra_price", label: "LCRA zone", color: "var(--s3)", values: s.lcra_price, format: usd },
    ] },
    { title: "Binding constraints, shadow price $/MWh", yFmt: p, series: [
      { key: "max_shadow_price", label: "Highest, statewide", color: "var(--s1)", values: s.max_shadow_price, format: usd },
      { key: "near_node_shadow_price", label: "GEORSO line (near node)", color: "var(--s2)", values: s.near_node_shadow_price, format: usd },
    ] },
  ];
}

function RuleTrace({ n, d, i }: { n: Node; d: Demo; i: number }) {
  const qs = d.alert.questions;
  if (n.k === "not") return <><span className="op">not</span> (<RuleTrace n={n.a} d={d} i={i} />)</>;
  if (n.k !== "cmp")
    return <><RuleTrace n={n.a} d={d} i={i} /> <span className="op">{n.k}</span> <RuleTrace n={n.b} d={d} i={i} /></>;
  const q = qs.find((x) => x.id === n.qid)!;
  const v = refValue(d.decisions[i][n.qid], q, n.option);
  const ok = evaluate(n, d.decisions[i], qs);
  const ref = n.option ? `${n.qid}.'${n.option}'` : n.qid;
  return (
    <span className={`clause ${ok ? "pass" : "fail"}`}>
      {ref} <b>{typeof v === "number" ? v.toFixed(2) : `'${v}'`}</b> {n.op} {typeof n.value === "number" ? n.value : `'${n.value}'`}
      <span className="verdict">{ok ? " ✓" : " ✗"}</span>
    </span>
  );
}

function Answer({ q, a }: { q: Question; a: Demo["decisions"][number][string] }) {
  if (a.refused) return <div className="answer"><div className="answer-q">{q.text}</div><p className="muted">Refused by the model.</p></div>;
  const opts = q.kind === "probability" ? ["yes"] : q.options;
  const top = Object.entries(a.probs).reduce((b, c) => (c[1] > b[1] ? c : b))[0];
  return (
    <div className="answer">
      <div className="answer-q">{q.text}</div>
      {opts.map((o) => {
        const p = a.probs[o] ?? 0;
        return (
          <div key={o} className={`pbar${q.kind === "probability" || o === top ? " top" : ""}`}>
            <span className="pbar-label">{q.kind === "probability" ? "Yes" : o}</span>
            <span className="pbar-track"><span className="pbar-fill" style={{ width: `${Math.max(p * 100, 1)}%` }} /></span>
            <span className="pbar-value">{Math.round(p * 100)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function Chips({ label, cls, idxs, idx, t, onPick }: { label: string; cls: string; idxs: number[]; idx: number; t: string[]; onPick: (i: number) => void }) {
  const [all, setAll] = useState(false);
  const LIMIT = 10;
  const shown = all ? idxs : idxs.slice(0, LIMIT);
  return (
    <div className="chips">
      <span className="chips-label"><span className={`dot ${cls}`} /> {label}</span>
      <div className="chip-list">
        {idxs.length === 0 && <span className="muted small">none all day</span>}
        {shown.map((i) => <button key={i} type="button" className={`chip ${cls}${i === idx ? " on" : ""}`} onClick={() => onPick(i)}>{clock(t[i])}</button>)}
        {idxs.length > LIMIT && (
          <button type="button" className="chip more" onClick={() => setAll(!all)}>{all ? "show fewer" : `+${idxs.length - LIMIT} more`}</button>
        )}
      </div>
    </div>
  );
}

function usePlayer(n: number, stops: Set<number>, idx: number, setIdx: (i: number) => void) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (idx >= n - 1) { setPlaying(false); return; }
    const id = setTimeout(() => setIdx(idx + 1), stops.has(idx) ? 1600 : 45);
    return () => clearTimeout(id);
  }, [playing, idx, n, stops, setIdx]);
  const toggle = () => {
    if (!playing && idx >= n - 1) setIdx(0);
    setPlaying(!playing);
  };
  return { playing, toggle, stop: () => setPlaying(false) };
}

function Scenario({ d, whatif }: { d: Demo; whatif?: Sim }) {
  const copy = COPY[d.scenario.scenario];
  const [ref, width] = useWidth<HTMLDivElement>();
  const X = useMemo(() => makeX(d.t, width), [d.t, width]);
  const [ref2, width2] = useWidth<HTMLDivElement>();
  const X2 = useMemo(() => makeX(d.t, width2), [d.t, width2]);
  const tree = useMemo(() => parse(d.alert.rule, d.alert.questions), [d]);
  // Compose in the browser: rule + threshold + cooldown, from the decision JSON alone.
  const ruleTrue = useMemo(() => d.decisions.map((a) => evaluate(tree, a, d.alert.questions)), [d, tree]);
  const thrTrue = useMemo(() => d.series[d.alert.baseline_threshold.series].map((v) => thresholdHit(d.alert.baseline_threshold, v)), [d]);
  const semFired = useMemo(() => cooldown(ruleTrue, d.t, d.cooldown_minutes), [ruleTrue, d]);
  const thrFired = useMemo(() => cooldown(thrTrue, d.t, d.cooldown_minutes), [thrTrue, d]);
  const parity = JSON.stringify([semFired, thrFired, ruleTrue]) === JSON.stringify([d.fired.semantic, d.fired.threshold, d.rule_true]);
  const primary = d.alert.questions.find((q) => q.id === d.alert.primary)!;
  const prob = d.decisions.map((a) => a[primary.id].probs.yes ?? 0);
  const cut = cutoffs(tree, primary.id)[0] ?? null;
  const stops = useMemo(() => new Set([...semFired, ...thrFired]), [semFired, thrFired]);

  const [idx, setIdxState] = useState(() => thrFired[0] ?? 0);
  const setIdx = useCallback((i: number) => setIdxState(Math.max(0, Math.min(d.t.length - 1, i))), [d.t.length]);
  const player = usePlayer(d.t.length, stops, idx, setIdx);
  const pick = (i: number) => { player.stop(); setIdx(i); };
  const scrub = (i: number) => { player.stop(); setIdx(i); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input[type=text], input:not([type]), textarea, summary, button")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); scrub(idx + (e.shiftKey ? 12 : 1)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); scrub(idx - (e.shiftKey ? 12 : 1)); }
      else if (e.key === " ") { e.preventDefault(); player.toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ex = d.explanations[d.t[idx]];
  const thrState = thrFired.includes(idx) ? "fired" : thrTrue[idx] ? "on" : "off";
  const semState = semFired.includes(idx) ? "fired" : ruleTrue[idx] ? "on" : "off";

  return (
    <>
      <section className="hero">
        <div className="eyebrow">The alert, written as a sentence</div>
        <blockquote>“{d.alert.sentence}”</blockquote>
        <p className="context">{copy.context}</p>
        <div className="versus">
          <div className="vs thr">
            <div className="vs-head"><span className="dot thr" /> Today's threshold alert</div>
            <div className="vs-rule"><code>{d.alert.baseline_label}</code></div>
            <div className="vs-num">{thrFired.length}<span>alerts sent</span></div>
            <p>{copy.thrSummary}</p>
          </div>
          <div className="vs sem">
            <div className="vs-head"><span className="dot sem" /> Semantic alert, decided by gpt-6-luna</div>
            <div className="vs-rule">{d.alert.questions.length} questions, asked every 5 minutes</div>
            <div className="vs-num">{semFired.length}<span>alerts sent</span></div>
            <p>{copy.semSummary}</p>
          </div>
        </div>
      </section>

      <section className="stage">
        <div className="stage-main" ref={ref}>
          <div className="controls">
            <button type="button" className="play" onClick={player.toggle}>{player.playing ? "❚❚ Pause" : "▶ Play the day"}</button>
            <input type="range" min={0} max={d.t.length - 1} value={idx} aria-label="Time of day" aria-valuetext={clock(d.t[idx])}
              onChange={(e) => scrub(Number(e.target.value))} />
            <span className="clock">{clock(d.t[idx])}</span>
          </div>
          <Chips label="Threshold alerts" cls="thr" idxs={thrFired} idx={idx} t={d.t} onPick={pick} />
          <Chips label="Semantic alerts" cls="sem" idxs={semFired} idx={idx} t={d.t} onPick={pick} />

          <div className="chart-block">
            <h3>{copy.watch.title}</h3>
            <div className="chart-legend">
              {copy.watch.series.map((s) => <span key={s.key}><i className={`sw ${s.cls}`} />{s.label} <b>{d.series[s.key][idx] !== null ? s.fmt(d.series[s.key][idx]!) : "n/a"}</b></span>)}
              <span><i className="sw zone-thr" />over the threshold</span>
              <span><i className="sw dot-thr" />alert sent</span>
            </div>
            <ThresholdChart X={X} t={d.t} idx={idx} onIdx={scrub} onPick={pick}
              series={copy.watch.series.map((s) => ({ label: s.label, values: d.series[s.key], cls: s.cls, fmt: s.fmt }))}
              log={copy.watch.log} threshold={d.alert.baseline_threshold.value} thresholdLabel={copy.watch.limitLabel}
              fired={thrFired} active={thrTrue} yTick={copy.watch.tick} />
          </div>
          <div className="chart-block">
            <h3>{copy.probTitle}</h3>
            <div className="chart-legend">
              <span><i className="sw c1" />Probability <b>{Math.round(prob[idx] * 100)}%</b></span>
              <span><i className="sw zone-sem" />whole rule true</span>
              <span><i className="sw dot-sem" />alert sent</span>
            </div>
            <ProbChart X={X} t={d.t} idx={idx} onIdx={scrub} onPick={pick} values={prob} cutoff={cut} ruleTrue={ruleTrue} fired={semFired} />
          </div>
          <div className="chart-block">
            <h3>{copy.reservesNote}</h3>
            <LinePanel title="" t={d.t} X={X} idx={idx} onIdx={scrub} height={130} yFmt={(v) => `${Math.round(v / 1000)} GW`}
              series={[{ key: "prc_mw", label: "Reserves (PRC)", color: "var(--s3)", values: d.series.prc_mw, format: gw }]} />
          </div>
          <p className="hint muted small">Hover or drag across a chart to move through the day · click a dot or a time to jump to an alert · ← → to step, space to play</p>
        </div>

        <aside className="inspector" aria-live="polite">
          <div className="insp-time">{clock(d.t[idx])} <span>{copy.date}, Central</span></div>
          <div className="readouts">
            {copy.readouts.map((r) => <div key={r.key}><span>{r.label}</span><b>{d.series[r.key][idx] !== null ? r.fmt(d.series[r.key][idx]!) : "n/a"}</b></div>)}
          </div>
          <div className={`status thr ${thrState}`}>
            <span className="dot thr" /> Threshold alert
            <b>{thrState === "fired" ? "ALERT SENT" : thrState === "on" ? "over threshold (cooldown)" : "quiet"}</b>
          </div>
          <div className={`status sem ${semState}`}>
            <span className="dot sem" /> Semantic alert
            <b>{semState === "fired" ? "ALERT SENT" : semState === "on" ? "rule true (cooldown)" : "quiet"}</b>
          </div>
          {ex ? (
            <div className={`why ${ex.kind}`}>
              <div className="why-head">{ex.kind === "fired" ? "Why the semantic alert fired" : "Why the semantic alert stayed quiet"}</div>
              <p>{ex.text}</p>
              <div className="muted small">Written by gpt-6-luna from the snapshot; every number checked against it.</div>
            </div>
          ) : (
            <div className="why none muted small">Explanations are written when an alert fires. Click a dot or a time above to jump to one.</div>
          )}
          <div className="answers">
            <div className="insp-label">gpt-6-luna's answers <span className="muted">· {d.decision_latency_ms[idx].toFixed(0)} ms</span></div>
            {d.alert.questions.map((q) => <Answer key={q.id} q={q} a={d.decisions[idx][q.id]} />)}
          </div>
          <details className="insp-more">
            <summary>Rule check</summary>
            <code className="trace"><RuleTrace n={tree} d={d} i={idx} /> → <b className={ruleTrue[idx] ? "ok" : ""}>{ruleTrue[idx] ? "true" : "false"}</b></code>
          </details>
          <details className="insp-more">
            <summary>The snapshot gpt-6-luna read</summary>
            <p className="prose">{d.prose[idx]}</p>
          </details>
        </aside>
      </section>

      <section className="how">
        <h2>How it works</h2>
        <div className="steps">
          <div className="step">
            <div className="step-n">1 · Compile once</div>
            <p>gpt-6-luna turns the sentence into typed questions and a rule{d.compile.attempts > 1 ? ` (${d.compile.attempts} attempts; a validator rejected the first)` : ""}.</p>
            <ul className="qs">
              {d.alert.questions.map((q) => <li key={q.id}><span className="kind">{q.kind === "probability" ? "yes/no" : q.kind}</span> {q.text}{q.kind !== "probability" && <span className="muted"> [{q.options.join(" · ")}]</span>}</li>)}
            </ul>
          </div>
          <div className="step">
            <div className="step-n">2 · Decide every 5 minutes</div>
            <p>The OpenAI Decisions API reads a short prose snapshot of the grid and returns a probability for every option. It writes no text.</p>
            <p className="muted small">{d.decision_stats.calls} snapshots · median {d.decision_stats.latency_ms.median.toFixed(0)} ms, p95 {d.decision_stats.latency_ms.p95.toFixed(0)} ms per request · ${d.decision_stats.cost_usd.toFixed(3)} for the day</p>
          </div>
          <div className="step">
            <div className="step-n">3 · Fire with plain code</div>
            <p>A small rule, evaluated in TypeScript, with the same 30-minute cooldown as the threshold alert:</p>
            <code className="rule">{d.alert.rule}</code>
            <p className={`small ${parity ? "ok" : "bad"}`}>{parity ? "✓ Recomputed in your browser; matches the precomputed run." : "✗ Browser recompute does not match the precomputed run."}</p>
          </div>
        </div>
      </section>

      <section className="notes-sec">
        <h2>What to notice, including what went wrong</h2>
        <ul className="notes">{copy.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="small"><a href={d.scenario.blog_url} target="_blank" rel="noreferrer">Grid Status's blog post on this day ↗</a></p>
      </section>

      <details className="more">
        <summary>More grid context</summary>
        <div ref={ref2}>
          {contextPanels(d).map((p) => (
            <LinePanel key={p.title} title={p.title} t={d.t} X={X2} series={p.series} idx={idx} onIdx={scrub} log={p.log} yFmt={p.yFmt} zero={p.zero} />
          ))}
        </div>
      </details>
      {whatif && (
        <details className="more">
          <summary>What if 8 GW of batteries had been offline? (simulated)</summary>
          <WhatIf real={d} sim={whatif} X={X2} idx={idx} onIdx={scrub} />
        </details>
      )}
      {import.meta.env.VITE_LIVE_API && <LiveBox scenario={d.scenario.scenario} />}
    </>
  );
}

export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [demos, setDemos] = useState<Record<string, Demo>>({});
  const [whatifs, setWhatifs] = useState<Record<string, Sim>>({});
  const [tab, setTabState] = useState<string>(() => (location.hash.slice(1) in COPY ? location.hash.slice(1) : "record_load"));
  const setTab = (k: string) => { setTabState(k); history.replaceState(null, "", `#${k}`); };
  const [err, setErr] = useState<string | null>(null);
  const [theme, nextTheme] = useTheme();

  useEffect(() => {
    fetch("demo/index.json").then((r) => r.json()).then(async (idx: IndexEntry[]) => {
      setIndex(idx);
      const all = await Promise.all(idx.map((e) => fetch(e.file).then((r) => r.json() as Promise<Demo>)));
      setDemos(Object.fromEntries(all.map((d) => [d.scenario.scenario, d])));
      const sims = await Promise.all(idx.map((e) => fetch(`demo/whatif_${e.alert_id}.json`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      setWhatifs(Object.fromEntries(sims.filter(Boolean).map((s: Sim) => [s.scenario.scenario, s])));
    }).catch((e) => setErr(String(e)));
  }, []);

  const d = demos[tab];
  const all = Object.values(demos);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">Semantic alerts <span className="muted">· a concept on ERCOT data</span></div>
        <nav className="tabs" role="tablist">
          {Object.entries(COPY).map(([k, v]) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {v.tab}<span>{v.date}</span>
            </button>
          ))}
        </nav>
        <button type="button" className="theme" onClick={nextTheme} aria-label={`Theme: ${theme}`}>{theme === "system" ? "◐ Auto" : theme === "light" ? "○ Light" : "● Dark"}</button>
      </header>
      <h1>Alerts written as sentences, decided by a model that never writes a word.</h1>

      {err && <p className="bad">Could not load demo data: {err}</p>}
      {!d && !err && <p className="muted">Loading…</p>}
      {d && <Scenario key={tab} d={d} whatif={whatifs[tab]} />}

      <footer>
        {index && all.length === index.length && (
          <p>
            {all.reduce((s, x) => s + x.decision_stats.decisions, 0).toLocaleString("en-US")} decisions by gpt-6-luna (OpenAI Decisions API, public beta).
            Latency per request, measured from a US laptop: {all.map((x) => `${COPY[x.scenario.scenario].date} median ${x.decision_stats.latency_ms.median.toFixed(0)} ms, p95 ${x.decision_stats.latency_ms.p95.toFixed(0)} ms`).join("; ")}.
            Compiling and explanations: gpt-6-luna on the Responses API.
          </p>
        )}
        <p>All model outputs were precomputed locally and are replayed here; this page makes no API calls.</p>
        <p>Data: Grid Status API{d ? ` · ${d.datasets.join(", ")} · ${d.scenario.day}` : ""}. Times are US Central.</p>
        <p className="muted">Independent concept demo. Not affiliated with Grid Status.</p>
      </footer>
    </div>
  );
}
