import { useEffect, useMemo, useState } from "react";
import { LinePanel, clock, makeX, useWidth, type Series } from "./chart";
import { WhatIf } from "./lanes";
import { LiveBox } from "./live";
import { cooldown, cutoffs, evaluate, parse, thresholdHit } from "./rule";
import { ProbChart, ThresholdChart } from "./story";
import type { Demo, IndexEntry, Question } from "./types";

type Sim = Demo & { simulated: { label: string; method: string } };

const gw = (v: number) => `${(v / 1000).toFixed(1)} GW`;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const range = (idxs: number[], t: string[]) => (idxs.length ? `${clock(t[idxs[0]])} to ${clock(t[idxs[idxs.length - 1]])}` : "");

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

function contextPanels(d: Demo): { title: string; series: Series[]; yFmt: (v: number) => string; zero?: boolean }[] {
  const s = d.series;
  const t = (v: number) => `${Math.round(v / 1000)}`;
  const p = (v: number) => (v >= 1000 ? `${v / 1000}k` : `${v}`);
  return [
    { title: "Demand and net load, GW", yFmt: t, zero: false, series: [
      { key: "load_mw", label: "Demand", color: "var(--s1)", values: s.load_mw, format: gw },
      { key: "load_forecast_mw", label: "Forecast (hourly)", color: "var(--muted-series)", values: s.load_forecast_mw, format: gw },
      { key: "net_load_mw", label: "Net load (demand minus wind and solar)", color: "var(--s2)", values: s.net_load_mw, format: gw },
    ] },
    { title: "Solar and batteries, GW", yFmt: t, series: [
      { key: "solar_mw", label: "Solar", color: "var(--s4)", values: s.solar_mw, format: gw },
      { key: "battery_discharge_mw", label: "Battery discharge", color: "var(--s3)", values: s.battery_discharge_mw, format: gw },
    ] },
    { title: "Prices, $/MWh", yFmt: p, series: [
      { key: "hub_rt_price", label: "Hub real-time", color: "var(--s1)", values: s.hub_rt_price, format: usd },
      { key: "hub_da_price", label: "Hub day-ahead (hourly)", color: "var(--muted-series)", values: s.hub_da_price, format: usd },
      { key: "nspin_price", label: "Non-spinning reserve", color: "var(--s2)", values: s.nspin_price, format: usd },
    ] },
  ];
}

function Answer({ q, a }: { q: Question; a: Demo["decisions"][number][string] }) {
  if (a.refused) return <div className="answer"><div className="answer-q">{q.text}</div><p className="muted">The model declined to answer.</p></div>;
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
            <span className="pbar-value">{pct(p)}</span>
          </div>
        );
      })}
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

function Story({ d, whatif }: { d: Demo; whatif?: Sim }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const X = useMemo(() => makeX(d.t, width), [d.t, width]);
  const [ref2, width2] = useWidth<HTMLDivElement>();
  const X2 = useMemo(() => makeX(d.t, width2), [d.t, width2]);
  const tree = useMemo(() => parse(d.alert.rule, d.alert.questions), [d]);
  // The fire/no-fire decision is recomputed here, in TypeScript, from the model's answers.
  const ruleTrue = useMemo(() => d.decisions.map((a) => evaluate(tree, a, d.alert.questions)), [d, tree]);
  const thrTrue = useMemo(() => d.series[d.alert.baseline_threshold.series].map((v) => thresholdHit(d.alert.baseline_threshold, v)), [d]);
  const semFired = useMemo(() => cooldown(ruleTrue, d.t, d.cooldown_minutes), [ruleTrue, d]);
  const thrFired = useMemo(() => cooldown(thrTrue, d.t, d.cooldown_minutes), [thrTrue, d]);
  const parity = JSON.stringify([semFired, thrFired, ruleTrue]) === JSON.stringify([d.fired.semantic, d.fired.threshold, d.rule_true]);
  const primary = d.alert.questions.find((q) => q.id === d.alert.primary)!;
  const prob = d.decisions.map((a) => a[primary.id].probs.yes ?? 0);
  const cut = cutoffs(tree, primary.id)[0] ?? null;
  const c = d.alert.contrast;
  const wantCut = c ? cutoffs(tree, c.question, c.want)[0] : undefined;
  const stops = useMemo(() => new Set([...semFired, ...thrFired]), [semFired, thrFired]);

  const [idx, setIdxState] = useState(() => thrFired[0] ?? 0);
  const setIdx = (i: number) => setIdxState(Math.max(0, Math.min(d.t.length - 1, i)));
  const player = usePlayer(d.t.length, stops, idx, setIdx);
  const go = (i: number) => { player.stop(); setIdx(i); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input:not([type=range]), textarea, summary, button")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(idx + (e.shiftKey ? 12 : 1)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - (e.shiftKey ? 12 : 1)); }
      else if (e.key === " ") { e.preventDefault(); player.toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ex = d.explanations[d.t[idx]];
  const thrSent = thrFired.includes(idx);
  const semSent = semFired.includes(idx);
  const s = d.series;
  const stats = d.decision_stats;

  return (
    <>
      <section className="intro">
        <h1>Alerts that check what you mean, not just one number</h1>
        <p>
          Grid alerts today usually watch a single number and fire when it crosses a line, such as ERCOT load above 90,000 MW.
          That works when the number is the thing you care about. Often it isn't. If you're worried about the grid running
          short, a demand record on its own doesn't tell you that.
        </p>
        <p>
          This demo tests a different kind of alert. You describe the condition in a sentence. A model turns that sentence into
          two short questions once, then answers them for every 5-minute snapshot of ERCOT. The alert fires when the answers pass
          a simple rule. It was run on real data for one day, and the results are replayed on this page.
        </p>
      </section>

      <section className="day">
        <h2>The test: July 22, 2026</h2>
        <p>
          ERCOT set an all-time demand record of 91.3 GW at 4:55 PM. Batteries kept prices low and reserves near 17 GW all
          afternoon, so the grid was not short during the record. It tightened after sunset: as solar faded and battery output
          came off its peak, reserves fell to about 6.5 GW and reserve prices passed $300/MWh around 10 PM.{" "}
          <a href={d.scenario.blog_url} target="_blank" rel="noreferrer">Grid Status's write-up of this day ↗</a>
        </p>
        <div className="compare">
          <div className="alert-card thr">
            <div className="card-kind"><span className="dot thr" /> Threshold alert <span className="muted">· how alerts work today</span></div>
            <div className="card-def"><code>{d.alert.baseline_label}</code></div>
            <div className="card-result"><b>{thrFired.length}</b> alerts, {range(thrFired, d.t)}</div>
            <p>Every one came during the record afternoon, while reserves were 16.5–17.7 GW and the hub price was under $82/MWh.</p>
          </div>
          <div className="alert-card sem">
            <div className="card-kind"><span className="dot sem" /> Sentence alert <span className="muted">· this demo</span></div>
            <div className="card-def">“{d.alert.sentence}”</div>
            <div className="card-result"><b>{semFired.length}</b> alerts, {range(semFired, d.t)}</div>
            <p>None during the record. It fired after sunset, as reserves fell from 9.2 to 6.6 GW and reserve prices rose.</p>
          </div>
        </div>
      </section>

      <section className="explore">
        <h2>Step through the day</h2>
        <p className="lede">
          Press play, or drag across a chart. <span className="key-dot thr" /> Orange dots are threshold alerts and{" "}
          <span className="key-dot sem" /> blue dots are sentence alerts. The details panel shows what the model answered at that moment.
        </p>
        <div className="stage">
          <div className="stage-main" ref={ref}>
            <div className="controls">
              <button type="button" className="play" onClick={player.toggle}>{player.playing ? "Pause" : "▶ Play"}</button>
              <input type="range" min={0} max={d.t.length - 1} value={idx} aria-label="Time of day" aria-valuetext={clock(d.t[idx])}
                onChange={(e) => go(Number(e.target.value))} />
              <span className="clock">{clock(d.t[idx])}</span>
            </div>
            <div className="jump">
              <span className="muted">Jump to an alert:</span>
              {thrFired.map((i) => <button key={i} type="button" className={`chip thr${i === idx ? " on" : ""}`} onClick={() => go(i)}>{clock(d.t[i])}</button>)}
              {semFired.map((i) => <button key={i} type="button" className={`chip sem${i === idx ? " on" : ""}`} onClick={() => go(i)}>{clock(d.t[i])}</button>)}
            </div>

            <div className="chart-block">
              <h3>Demand <span className="muted">· what the threshold alert watches</span></h3>
              <ThresholdChart X={X} t={d.t} idx={idx} onIdx={go} onPick={go}
                series={[{ label: "Demand", values: s.load_mw, cls: "c1", fmt: gw }]}
                threshold={d.alert.baseline_threshold.value} thresholdLabel="90 GW threshold"
                fired={thrFired} active={thrTrue} yTick={(v) => `${Math.round(v / 1000)} GW`} height={210} />
            </div>
            <div className="chart-block">
              <h3>“{primary.text}” <span className="muted">· the model's answer</span></h3>
              <ProbChart X={X} t={d.t} idx={idx} onIdx={go} onPick={go} values={prob} cutoff={cut} ruleTrue={ruleTrue} fired={semFired} />
            </div>
            <div className="chart-block">
              <h3>Operating reserves <span className="muted">· spare capacity ERCOT can call on; lower means tighter</span></h3>
              <LinePanel title="" t={d.t} X={X} idx={idx} onIdx={go} height={120} yFmt={(v) => `${Math.round(v / 1000)} GW`}
                series={[{ key: "prc_mw", label: "Reserves", color: "var(--s3)", values: s.prc_mw, format: gw }]} />
            </div>
          </div>

          <aside className="inspector" aria-live="polite">
            <div className="insp-time">{clock(d.t[idx])}</div>
            <div className="readouts">
              <div><span>Demand</span><b>{s.load_mw[idx] !== null ? gw(s.load_mw[idx]!) : "n/a"}</b></div>
              <div><span>Reserves</span><b>{s.prc_mw[idx] !== null ? gw(s.prc_mw[idx]!) : "n/a"}</b></div>
              <div><span>Hub price</span><b>{s.hub_rt_price[idx] !== null ? `${usd(s.hub_rt_price[idx]!)}/MWh` : "n/a"}</b></div>
            </div>
            <div className={`status thr${thrSent ? " sent" : ""}`}><span className="dot thr" /> Threshold alert <b>{thrSent ? "Sent" : "Not sent"}</b></div>
            <div className={`status sem${semSent ? " sent" : ""}`}><span className="dot sem" /> Sentence alert <b>{semSent ? "Sent" : "Not sent"}</b></div>
            {ex && (
              <div className={`why ${ex.kind}`}>
                <div className="why-head">{ex.kind === "fired" ? "Why the sentence alert fired" : "Why the sentence alert didn't fire"}</div>
                <p>{ex.text}</p>
              </div>
            )}
            <div className="insp-label">What the model answered</div>
            {d.alert.questions.map((q) => <Answer key={q.id} q={q} a={d.decisions[idx][q.id]} />)}
            {cut !== null && c && wantCut !== undefined ? (
              <p className="muted small rule-line">
                The alert fires when the first answer is at least {pct(cut)} and the second gives “{c.want}” at least {pct(wantCut)}.
                Right now: <b className={ruleTrue[idx] ? "ok" : ""}>{ruleTrue[idx] ? "both are met" : "not met"}</b>.
              </p>
            ) : (
              <p className="muted small rule-line">Rule: <code>{d.alert.rule}</code> · now {ruleTrue[idx] ? "true" : "false"}</p>
            )}
            <details className="insp-more">
              <summary>What the model read at {clock(d.t[idx])}</summary>
              <p className="prose">{d.prose[idx]}</p>
            </details>
          </aside>
        </div>
      </section>

      <section className="how">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <b>Turn the sentence into questions, once.</b> A language model (OpenAI gpt-6-luna) reads the sentence and writes
            these questions, plus a rule for combining the answers. A validator rejects results that don't fit, for example a
            rule that wouldn't exclude “just setting demand records.”
            <ul className="qs">
              {d.alert.questions.map((q) => <li key={q.id}>{q.text} <span className="muted">({q.kind === "probability" ? "yes / no" : q.options.join(" / ")})</span></li>)}
            </ul>
          </li>
          <li>
            <b>Describe each 5-minute snapshot in a few sentences.</b> Demand, forecast, solar, wind, batteries, prices and
            reserves, and how they changed over the last hour, from the Grid Status API. Each snapshot only uses data available at that moment.
          </li>
          <li>
            <b>Answer the questions for every snapshot.</b> OpenAI's Decisions API returns a probability for each answer
            rather than text: {stats.calls} snapshots, a median of {stats.latency_ms.median.toFixed(0)} ms each, ${stats.cost_usd.toFixed(3)} for the whole day.
          </li>
          <li>
            <b>Decide with ordinary code.</b> The rule is checked in plain code, with the same 30-minute cooldown as the
            threshold alert. The model writes text again only to explain an alert.
            <code className="rule">{d.alert.rule}</code>
            <span className={`small ${parity ? "ok" : "bad"}`}>{parity ? "✓ This page recomputes every alert from the model's answers, and the results match." : "✗ The recomputed alerts don't match the saved run."}</span>
          </li>
        </ol>
      </section>

      <section className="limits">
        <h2>What didn't work as well</h2>
        <ul>
          <li><b>It's close to the line.</b> The four alerts came at 70–73% against a 70% cutoff. Between 8:15 and 9:15 PM, while reserves were already falling, the answer sat just under 70% and nothing fired.</li>
          <li><b>The same sentence can produce a different alert.</b> A second run turned the sentence into a 60% cutoff, which fired 7 times, including once at 7:00 AM, when prices and reserve prices were low. A real product would save the compiled questions and show them to the user.</li>
          <li><b>The second question didn't help.</b> It was meant to separate “scarcity approaching” from “demand record only”, but it picked “scarcity approaching” during the record afternoon too. The first question did the real work.</li>
          <li><b>One day isn't an evaluation.</b> This shows the idea on a day where a threshold is known to mislead. It doesn't measure accuracy.</li>
        </ul>
      </section>

      <details className="more">
        <summary>More data from the day</summary>
        <div ref={ref2}>
          {contextPanels(d).map((p) => (
            <LinePanel key={p.title} title={p.title} t={d.t} X={X2} series={p.series} idx={idx} onIdx={go} yFmt={p.yFmt} zero={p.zero} />
          ))}
        </div>
      </details>
      {whatif && (
        <details className="more">
          <summary>What if 8 GW of batteries had been offline? (simulated)</summary>
          <WhatIf real={d} sim={whatif} X={X2} idx={idx} onIdx={go} />
        </details>
      )}
      {import.meta.env.VITE_LIVE_API && <LiveBox scenario={d.scenario.scenario} />}
    </>
  );
}

export default function App() {
  const [d, setD] = useState<Demo | null>(null);
  const [whatif, setWhatif] = useState<Sim | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const [theme, nextTheme] = useTheme();

  useEffect(() => {
    fetch("demo/index.json").then((r) => r.json()).then(async ([entry]: IndexEntry[]) => {
      setD(await fetch(entry.file).then((r) => r.json()));
      const sim = await fetch(`demo/whatif_${entry.alert_id}.json`).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined);
      setWhatif(sim);
    }).catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="page">
      <header className="top">
        <span className="brand">ERCOT alert concept</span>
        <button type="button" className="theme" onClick={nextTheme} aria-label={`Theme: ${theme}`}>{theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}</button>
      </header>
      {err && <p className="bad">Could not load the data: {err}</p>}
      {!d && !err && <p className="muted">Loading…</p>}
      {d && <Story d={d} whatif={whatif} />}
      <footer>
        <p>Data from the Grid Status API{d ? ` (${d.datasets.join(", ")})` : ""}. Times are US Central.</p>
        <p>Model: OpenAI gpt-6-luna, through the Decisions API for answers and the Responses API for the questions and explanations. All outputs were generated ahead of time; this page doesn't call any API.</p>
        <p className="muted">An independent concept demo. Not affiliated with Grid Status.</p>
      </footer>
    </div>
  );
}
