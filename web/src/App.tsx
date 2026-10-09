import { useEffect, useMemo, useState } from "react";
import { LinePanel, clock, makeX, useWidth, type Series } from "./chart";
import { WhatIf } from "./lanes";
import { LiveBox } from "./live";
import { Ribbon, TourBar, hhmm, type TourStep } from "./features";
import { cooldown, cutoffs, evaluate, parse, thresholdHit, withCutoff } from "./rule";
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
  const primary = d.alert.questions.find((q) => q.id === d.alert.primary)!;
  const origCut = cutoffs(tree, primary.id)[0] ?? null;
  const origThr = d.alert.baseline_threshold.value;
  const c = d.alert.contrast;
  const wantCut = c ? cutoffs(tree, c.question, c.want)[0] : undefined;

  // Settings sliders: the same model answers, re-decided with a different cutoff or threshold.
  const [cut, setCut] = useState<number | null>(origCut);
  const [thrValue, setThrValue] = useState(origThr);
  const [showSettings, setShowSettings] = useState(false);
  const tuned = cut !== origCut || thrValue !== origThr;
  const resetSettings = () => { setCut(origCut); setThrValue(origThr); };
  const liveTree = useMemo(() => (cut === null ? tree : withCutoff(tree, primary.id, cut)), [tree, primary.id, cut]);

  // The fire/no-fire decision is recomputed here, in TypeScript, from the model's answers.
  const ruleTrue = useMemo(() => d.decisions.map((a) => evaluate(liveTree, a, d.alert.questions)), [d, liveTree]);
  const thr = useMemo(() => ({ ...d.alert.baseline_threshold, value: thrValue }), [d, thrValue]);
  const thrTrue = useMemo(() => d.series[thr.series].map((v) => thresholdHit(thr, v)), [d, thr]);
  const semFired = useMemo(() => cooldown(ruleTrue, d.t, d.cooldown_minutes), [ruleTrue, d]);
  const thrFired = useMemo(() => cooldown(thrTrue, d.t, d.cooldown_minutes), [thrTrue, d]);
  const parity = useMemo(() => {
    const rt = d.decisions.map((a) => evaluate(tree, a, d.alert.questions));
    const tt = d.series[d.alert.baseline_threshold.series].map((v) => thresholdHit(d.alert.baseline_threshold, v));
    return JSON.stringify([cooldown(rt, d.t, d.cooldown_minutes), cooldown(tt, d.t, d.cooldown_minutes), rt])
      === JSON.stringify([d.fired.semantic, d.fired.threshold, d.rule_true]);
  }, [d, tree]);
  const prob = d.decisions.map((a) => a[primary.id].probs.yes ?? 0);
  const stops = useMemo(() => new Set([...semFired, ...thrFired]), [semFired, thrFired]);
  const s = d.series;

  // Start at a #t=HH:MM link if there is one, else at the first threshold alert.
  const [idx, setIdxState] = useState(() => {
    const m = location.hash.match(/t=(\d{1,2}):?(\d{2})/);
    const k = m ? d.t.findIndex((t) => hhmm(t) === `${m[1].padStart(2, "0")}:${m[2]}`) : -1;
    return k >= 0 ? k : thrFired[0] ?? 0;
  });
  const setIdx = (i: number) => setIdxState(Math.max(0, Math.min(d.t.length - 1, i)));
  const player = usePlayer(d.t.length, stops, idx, setIdx);
  useEffect(() => {
    const id = setTimeout(() => history.replaceState(null, "", `#t=${hhmm(d.t[idx])}`), 250);
    return () => clearTimeout(id);
  }, [idx, d.t]);

  // Guided tour: five moments, captions filled from the data at each one.
  const at = (label: string) => Math.max(0, d.t.findIndex((t) => clock(t) === label));
  const P = (i: number) => `${Math.round(prob[i] * 100)}%`;
  const v = (k: string, i: number, f: (x: number) => string) => (s[k][i] === null ? "n/a" : f(s[k][i]!));
  const usdMWh = (x: number) => `${usd(x)}/MWh`;
  const steps: TourStep[] = useMemo(() => {
    const a = at("2:55 PM"), b = at("4:55 PM"), f = d.fired.semantic[0] ?? at("8:10 PM"), m = at("8:45 PM"), z = at("10:05 PM");
    const nextAfter = d.fired.semantic.find((i) => i > m);
    const lastBefore = [...d.fired.semantic].reverse().find((i) => i <= z);
    return [
      { idx: a, title: `${clock(d.t[a])}: demand crosses 90 GW`,
        body: `The threshold alert fires. The model puts the chance that ERCOT is heading toward scarcity at ${P(a)}: reserves are ${v("prc_mw", a, gw)} and the hub price is ${v("hub_rt_price", a, usdMWh)}.` },
      { idx: b, title: `${clock(d.t[b])}: an all-time record`,
        body: `Demand peaks at ${v("load_mw", b, gw)}. The threshold alert has fired ${d.fired.threshold.filter((i) => i <= b).length} times and keeps going every 30 minutes. The sentence alert stays quiet at ${P(b)}, because reserves are still ${v("prc_mw", b, gw)}.` },
      { idx: f, title: `${clock(d.t[f])}: the sentence alert fires`,
        body: `Solar is down to ${v("solar_mw", f, gw)}, batteries are covering ${v("battery_discharge_mw", f, gw)}, and reserves have fallen to ${v("prc_mw", f, gw)}. The model's answer reaches ${P(f)}. The threshold alert is silent: demand has dropped to ${v("load_mw", f, gw)}.` },
      { idx: m, title: `${clock(d.t[m])}: a weak spot`,
        body: `Reserves are still near ${v("prc_mw", m, gw)}, but the model's answer has fallen back to ${P(m)}.${nextAfter !== undefined ? ` The alert doesn't fire again until ${clock(d.t[nextAfter])}.` : ""} The answer is jumpy from one snapshot to the next.` },
      { idx: z, title: `${clock(d.t[z])}: the tightest moment`,
        body: `The hub price hits ${v("hub_rt_price", z, usdMWh)}, non-spinning reserve ${v("nspin_price", z, usdMWh)}, and reserves are down to ${v("prc_mw", z, gw)}. The model says ${P(z)}.${lastBefore !== undefined && lastBefore !== z ? ` No new alert: the last one was at ${clock(d.t[lastBefore])}, inside the 30-minute cooldown.` : ""}` },
    ];
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tour, setTour] = useState<number | null>(null);
  const tourGo = (k: number) => {
    const n = Math.max(0, Math.min(steps.length - 1, k));
    player.stop(); resetSettings(); setShowSettings(false); setTour(n); setIdx(steps[n].idx);
  };
  const go = (i: number) => { player.stop(); setTour(null); setIdx(i); };
  const hover = (i: number) => { if (tour === null) go(i); };
  const pick = (i: number) => { go(i); document.getElementById("explore")?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input:not([type=range]), textarea, summary, button")) return;
      if (tour !== null) {
        if (e.key === "ArrowRight") { e.preventDefault(); tourGo(tour + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); tourGo(tour - 1); }
        else if (e.key === "Escape") setTour(null);
        return;
      }
      if (e.key === "ArrowRight") { e.preventDefault(); go(idx + (e.shiftKey ? 12 : 1)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - (e.shiftKey ? 12 : 1)); }
      else if (e.key === " ") { e.preventDefault(); player.toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ex = tuned ? undefined : d.explanations[d.t[idx]];
  const thrSent = thrFired.includes(idx);
  const semSent = semFired.includes(idx);
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
            <div className="card-result"><b>{thrFired.length}</b> alerts{thrFired.length ? `, ${range(thrFired, d.t)}` : ""}</div>
            <Ribbon t={d.t} fired={thrFired} cls="thr" onPick={pick} />
            {tuned
              ? <p className="tuned-note">With your settings ({Math.round(thrValue / 1000)} GW). Originally 8 alerts at 90 GW.</p>
              : <p>Every one came during the record afternoon, while reserves were 16.5–17.7 GW and the hub price was under $82/MWh.</p>}
          </div>
          <div className="alert-card sem">
            <div className="card-kind"><span className="dot sem" /> Sentence alert <span className="muted">· this demo</span></div>
            <div className="card-def">“{d.alert.sentence}”</div>
            <div className="card-result"><b>{semFired.length}</b> alerts{semFired.length ? `, ${range(semFired, d.t)}` : ""}</div>
            <Ribbon t={d.t} fired={semFired} cls="sem" onPick={pick} />
            {tuned
              ? <p className="tuned-note">With your settings (cutoff {pct(cut ?? 0)}). Originally 4 alerts at 70%.</p>
              : <p>None during the record. It fired after sunset, as reserves fell from 9.2 to 6.6 GW and reserve prices rose.</p>}
          </div>
        </div>
      </section>

      <section className="explore" id="explore">
        <h2>Step through the day</h2>
        <p className="lede">
          Take the tour for the five moments that matter, or press play and drag across the charts yourself.{" "}
          <span className="nowrap"><span className="key-dot thr" /> Orange dots</span> are threshold alerts and{" "}
          <span className="nowrap"><span className="key-dot sem" /> blue dots</span> are sentence alerts.
        </p>
        <div className="stage">
          <div className="stage-main" ref={ref}>
            <div className="controls">
              <button type="button" className="tour-btn" onClick={() => (tour === null ? tourGo(0) : setTour(null))}>{tour === null ? "Take the tour" : "End tour"}</button>
              <button type="button" className="play" onClick={() => { setTour(null); player.toggle(); }}>{player.playing ? "Pause" : "▶ Play"}</button>
              <input type="range" min={0} max={d.t.length - 1} value={idx} aria-label="Time of day" aria-valuetext={clock(d.t[idx])}
                onChange={(e) => go(Number(e.target.value))} />
              <span className="clock">{clock(d.t[idx])}</span>
            </div>
            {tour !== null && <TourBar steps={steps} at={tour} onGo={tourGo} onClose={() => setTour(null)} />}
            <div className="settings-bar">
              <button type="button" className={`settings-toggle${showSettings ? " on" : ""}`} onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}>
                {showSettings ? "Hide settings" : "Adjust settings"}{tuned && !showSettings ? " (changed)" : ""}
              </button>
              {showSettings && (
                <div className="settings">
                  {origCut !== null && (
                    <label>
                      <span>Sentence alert cutoff <b>{pct(cut ?? 0)}</b></span>
                      <input type="range" min={0.4} max={0.9} step={0.05} value={cut ?? 0} onChange={(e) => setCut(Number(e.target.value))} />
                      <small>{semFired.length} alerts · the model chose {pct(origCut)}</small>
                    </label>
                  )}
                  <label>
                    <span>Threshold <b>{Math.round(thrValue / 1000)} GW</b></span>
                    <input type="range" min={85000} max={92000} step={1000} value={thrValue} onChange={(e) => setThrValue(Number(e.target.value))} />
                    <small>{thrFired.length} alerts · the preset is {Math.round(origThr / 1000)} GW</small>
                  </label>
                  <button type="button" className="reset" onClick={resetSettings} disabled={!tuned}>Reset</button>
                </div>
              )}
            </div>
            <div className="jump">
              <span className="muted">Jump to an alert:</span>
              {thrFired.map((i) => <button key={i} type="button" className={`chip thr${i === idx ? " on" : ""}`} onClick={() => go(i)}>{clock(d.t[i])}</button>)}
              {semFired.map((i) => <button key={i} type="button" className={`chip sem${i === idx ? " on" : ""}`} onClick={() => go(i)}>{clock(d.t[i])}</button>)}
            </div>

            <div className="chart-block">
              <h3>Demand <span className="muted">· what the threshold alert watches</span></h3>
              <ThresholdChart X={X} t={d.t} idx={idx} onIdx={hover} onPick={go}
                series={[{ label: "Demand", values: s.load_mw, cls: "c1", fmt: gw }]}
                threshold={thrValue} thresholdLabel={`${Math.round(thrValue / 1000)} GW threshold`}
                fired={thrFired} active={thrTrue} yTick={(v) => `${Math.round(v / 1000)} GW`} height={210} />
            </div>
            <div className="chart-block">
              <h3>“{primary.text}” <span className="muted">· the model's answer</span></h3>
              <ProbChart X={X} t={d.t} idx={idx} onIdx={hover} onPick={go} values={prob} cutoff={cut} ruleTrue={ruleTrue} fired={semFired} />
            </div>
            <div className="chart-block">
              <h3>Operating reserves <span className="muted">· spare capacity ERCOT can call on; lower means tighter</span></h3>
              <LinePanel title="" t={d.t} X={X} idx={idx} onIdx={hover} height={120} yFmt={(v) => `${Math.round(v / 1000)} GW`}
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
            <div key={thrSent ? `t${idx}` : "t"} className={`status thr${thrSent ? " sent" : ""}`}><span className="dot thr" /> Threshold alert <b>{thrSent ? "Sent" : "Not sent"}</b></div>
            <div key={semSent ? `s${idx}` : "s"} className={`status sem${semSent ? " sent" : ""}`}><span className="dot sem" /> Sentence alert <b>{semSent ? "Sent" : "Not sent"}</b></div>
            {tuned && (thrSent || semSent) && <p className="muted small">Explanations were written for the original settings, so none is shown here.</p>}
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
          <li><b>It's close to the line, and jumpy.</b> The four alerts came at 70–73% against a 70% cutoff. Between 8:20 and 9:10 PM, with reserves holding near 9 GW, the answer fell back to 21–58% before rising again. Try the cutoff slider above to see how much the result depends on it.</li>
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
