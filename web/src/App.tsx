import { useEffect, useMemo, useState } from "react";
import { Panel, makeX, useWidth, type Tick } from "./chart";
import { cooldown, cutoffs, evaluate, parse, thresholdHit, withCutoff } from "./rule";
import { Answers, BASE, Shell, gw, orNA, pct, usd } from "./site";
import type { Demo, IndexEntry } from "./types";

const TZ = "America/Chicago";
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
/** "20:10" in Central time, for #t= links. */
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const between = (idxs: number[], t: string[]) => (idxs.length ? `${clock(t[idxs[0]])} to ${clock(t[idxs[idxs.length - 1]])}` : "");
const gwTick = (v: number) => `${Math.round(v / 1000)}`;

interface Moment { idx: number; title: string; body: string }

/** Five moments of the day, with captions read from the data at each one. */
function moments(d: Demo, prob: number[], semFired: number[], thrFired: number[]): Moment[] {
  const s = d.series;
  const at = (label: string) => Math.max(0, d.t.findIndex((t) => clock(t) === label));
  const P = (i: number) => pct(prob[i]);
  const v = (k: string, i: number, f: (x: number) => string) => orNA(s[k][i], f);
  const mwh = (x: number) => `${usd(x)}/MWh`;
  const a = thrFired[0] ?? at("2:55 PM");
  const b = s.load_mw.reduce<number>((best, x, i) => (x !== null && x > (s.load_mw[best] ?? -1) ? i : best), 0);
  const f = semFired[0] ?? at("8:10 PM");
  const m = at("8:45 PM");
  const z = s.hub_rt_price.reduce<number>((best, x, i) => (x !== null && x > (s.hub_rt_price[best] ?? -1) ? i : best), 0);
  const next = semFired.find((i) => i > m);
  const last = [...semFired].reverse().find((i) => i <= z);
  return [
    { idx: a, title: "Demand crosses 90 GW",
      body: `The threshold alert fires. The model puts the chance that ERCOT is heading toward scarcity at ${P(a)}: reserves are ${v("prc_mw", a, gw)} and the hub price is ${v("hub_rt_price", a, mwh)}.` },
    { idx: b, title: "An all-time record",
      body: `Demand peaks at ${v("load_mw", b, gw)}. The threshold alert has fired ${thrFired.filter((i) => i <= b).length} times and repeats every 30 minutes. The sentence alert stays quiet at ${P(b)}, because reserves are still ${v("prc_mw", b, gw)}.` },
    { idx: f, title: "The sentence alert fires",
      body: `Solar is down to ${v("solar_mw", f, gw)}, batteries are covering ${v("battery_discharge_mw", f, gw)}, and reserves have fallen to ${v("prc_mw", f, gw)}. The model's answer reaches ${P(f)}. The threshold alert is silent: demand has dropped to ${v("load_mw", f, gw)}.` },
    { idx: m, title: "A weak spot",
      body: `Reserves are still near ${v("prc_mw", m, gw)}, but the model's answer has fallen back to ${P(m)}.${next !== undefined ? ` It doesn't fire again until ${clock(d.t[next])}.` : ""} The answer is jumpy from one snapshot to the next.` },
    { idx: z, title: "The tightest moment",
      body: `The hub price hits ${v("hub_rt_price", z, mwh)}, non-spinning reserve ${v("nspin_price", z, mwh)}, and reserves are down to ${v("prc_mw", z, gw)}. The model says ${P(z)}.${last !== undefined && last !== z ? ` No new alert: the last one, at ${clock(d.t[last])}, is inside the 30-minute cooldown.` : ""}` },
  ];
}

function Story({ d }: { d: Demo }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const X = useMemo(() => makeX(d.t.length, width), [d.t.length, width]);
  const tree = useMemo(() => parse(d.alert.rule, d.alert.questions), [d]);
  const primary = d.alert.questions.find((q) => q.id === d.alert.primary)!;
  const cut = cutoffs(tree, primary.id)[0] ?? null;
  const thr = d.alert.baseline_threshold;
  const s = d.series;
  const prob = useMemo(() => d.decisions.map((a) => a[primary.id].probs.yes ?? 0), [d, primary.id]);

  // Every alert is recomputed here from the model's answers, and checked against the pipeline's run.
  const ruleTrue = useMemo(() => d.decisions.map((a) => evaluate(tree, a, d.alert.questions)), [d, tree]);
  const thrTrue = useMemo(() => s[thr.series].map((v) => thresholdHit(thr, v)), [s, thr]);
  const semFired = useMemo(() => cooldown(ruleTrue, d.t, d.cooldown_minutes), [ruleTrue, d]);
  const thrFired = useMemo(() => cooldown(thrTrue, d.t, d.cooldown_minutes), [thrTrue, d]);
  const parity = JSON.stringify([semFired, thrFired, ruleTrue]) === JSON.stringify([d.fired.semantic, d.fired.threshold, d.rule_true]);
  const firesAt = (c: number) => {
    const t = withCutoff(tree, primary.id, c);
    return cooldown(d.decisions.map((a) => evaluate(t, a, d.alert.questions)), d.t, d.cooldown_minutes).length;
  };

  const steps = useMemo(() => moments(d, prob, semFired, thrFired), [d, prob, semFired, thrFired]);
  const fromHash = () => {
    const m = location.hash.match(/t=(\d{1,2}):?(\d{2})/);
    return m ? d.t.findIndex((t) => hhmm(t) === `${m[1].padStart(2, "0")}:${m[2]}`) : -1;
  };
  const [pinned, setPinned] = useState(() => (fromHash() >= 0 ? fromHash() : steps[0].idx));
  const [hover, setHover] = useState<number | null>(null);
  const idx = hover ?? pinned;
  const pin = (i: number) => {
    const k = Math.max(0, Math.min(d.t.length - 1, i));
    setPinned(k);
    setHover(null);
    history.replaceState(null, "", `#t=${hhmm(d.t[k])}`);
  };

  useEffect(() => {
    const onHash = () => { const k = fromHash(); if (k >= 0) { setPinned(k); setHover(null); } };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        pin(pinned + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 12 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const hourTicks: Tick[] = d.t.flatMap((iso, i) => {
    const t = new Date(iso);
    const h = Number(t.toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false })) % 24;
    return t.getUTCMinutes() === 0 && h % (width < 560 ? 6 : 3) === 0
      ? [{ i, label: h === 0 ? "12 am" : h === 12 ? "noon" : `${h % 12} ${h < 12 ? "am" : "pm"}` }] : [];
  });
  const moment = steps.findIndex((m) => m.idx === idx);
  const ex = d.explanations[d.t[idx]];
  const thrSent = thrFired.includes(idx);
  const semSent = semFired.includes(idx);
  const stats = d.decision_stats;
  const prcAt = (idxs: number[]) => idxs.map((i) => s.prc_mw[i]).filter((v): v is number => v !== null);
  const range = (vals: number[]) => `${(Math.min(...vals) / 1000).toFixed(1)}–${(Math.max(...vals) / 1000).toFixed(1)} GW`;

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Concept demo · ERCOT · July 22, 2026</p>
        <h1>An alert that reads a sentence, not a number</h1>
        <p className="lede">
          Grid alerts usually watch one number, like ERCOT demand above 90 GW. This one is written as a sentence. A model
          turns it into two questions once, answers them for every 5-minute snapshot of the grid, and plain code decides when
          to alert. Here is how both alerts handled July 22, 2026, when ERCOT set an all-time demand record but didn't get
          tight until after sunset.
        </p>
        <div className="versus">
          <div>
            <div className="kind"><span className="key-dot thr" /> Threshold alert</div>
            <div className="def"><code>{d.alert.baseline_label}</code></div>
            <div className="big">{thrFired.length}<small>alerts</small></div>
            <p className="verdict">{between(thrFired, d.t)}, during the record afternoon. Reserves were {range(prcAt(thrFired))} the whole time.</p>
          </div>
          <div>
            <div className="kind"><span className="key-dot sem" /> Sentence alert</div>
            <div className="def">“{d.alert.sentence}”</div>
            <div className="big">{semFired.length}<small>alerts</small></div>
            <p className="verdict">
              {between(semFired, d.t)}, after sunset, as reserves fell
              from {orNA(s.prc_mw[semFired[0]], gw)} to {orNA(s.prc_mw[semFired[semFired.length - 1]], gw)}.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2>The day, five minutes at a time</h2>
        <p className="section-lede">Pick a moment, or hover over the charts. Dots mark each alert. ← → step through the day.</p>
        <div className="moments" role="group" aria-label="Moments of the day">
          {steps.map((m, k) => (
            <button key={k} type="button" className="moment" aria-pressed={k === moment} onClick={() => pin(m.idx)}>
              <b>{clock(d.t[m.idx])}</b>{m.title}
            </button>
          ))}
        </div>
        <div className="panels" ref={ref}>
          <Panel X={X} idx={idx} pinned={pinned} onHover={setHover} onPick={pin} label="ERCOT demand through the day, with the threshold alert's line and alerts"
            title={<>Demand, GW <span className="muted">· what the threshold alert watches</span></>} value={orNA(s.load_mw[idx], gw)}
            values={s.load_mw} yFmt={gwTick} height={96} shade={thrTrue} tone="thr" markers={thrFired}
            markerLabel={(i) => `Threshold alert at ${clock(d.t[i])}`}
            refLine={{ value: thr.value, label: `${thr.value / 1000} GW threshold`, tone: "thr", align: "start" }} />
          <Panel X={X} idx={idx} pinned={pinned} onHover={setHover} onPick={pin} label="The model's answer through the day, with the cutoff and alerts"
            title={<>Model's answer <span className="muted">· “{primary.text}”</span></>} value={pct(prob[idx])}
            values={prob} domain={[0, 1]} ticks={[0, 0.5, 1]} yFmt={pct} height={104} color="var(--sem)" shade={ruleTrue} tone="sem" markers={semFired}
            markerLabel={(i) => `Sentence alert at ${clock(d.t[i])}`}
            refLine={cut !== null ? { value: cut, label: `alerts at ${pct(cut)}`, tone: "sem", align: "start" } : undefined} />
          <Panel X={X} idx={idx} onHover={setHover} onPick={pin} label="Operating reserves through the day"
            title={<>Operating reserves, GW <span className="muted">· spare capacity; lower is tighter</span></>} value={orNA(s.prc_mw[idx], gw)}
            values={s.prc_mw} yFmt={gwTick} height={64} axis={hourTicks} />
        </div>

        <div className="readout" aria-live="polite">
          <div>
            <div className="readout-time">{clock(d.t[idx])}</div>
            <div className="facts">
              <span>Demand <b>{orNA(s.load_mw[idx], gw)}</b></span>
              <span>Reserves <b>{orNA(s.prc_mw[idx], gw)}</b></span>
              <span>Hub price <b>{orNA(s.hub_rt_price[idx], (x) => `${usd(x)}/MWh`)}</b></span>
            </div>
            <div className="states">
              <span className={`state${thrSent ? " on" : ""}`}><span className="key-dot thr" />Threshold
                <b>{thrSent ? "alert sent" : thrTrue[idx] ? "over the line, cooling down" : "quiet"}</b></span>
              <span className={`state${semSent ? " on" : ""}`}><span className="key-dot sem" />Sentence
                <b>{semSent ? "alert sent" : ruleTrue[idx] ? "rule met, cooling down" : "quiet"}</b></span>
            </div>
            {moment >= 0 && <p className="caption"><b>{steps[moment].title}</b>{steps[moment].body}</p>}
            {ex && (
              <p className="note">
                <span className="muted">gpt-6-luna's note on why the sentence alert {ex.kind === "fired" ? "fired" : "stayed quiet"}</span>
                {ex.text}
              </p>
            )}
          </div>
          <div>
            <Answers questions={d.alert.questions} answers={d.decisions[idx]} tree={tree} />
            <details className="read">
              <summary>What the model read at {clock(d.t[idx])}</summary>
              <p>{d.prose[idx]}</p>
            </details>
          </div>
        </div>
      </section>

      <section>
        <h2>How it works</h2>
        <div className="how">
          <div>
            <span className="n">1</span>
            <h3>Compile once</h3>
            <p>OpenAI's gpt-6-luna turns the sentence into questions and a rule. A validator rejects anything that doesn't fit, such as a rule that wouldn't exclude “just setting demand records.”</p>
            <ul>{d.alert.questions.map((q) => <li key={q.id}>{q.text}</li>)}</ul>
          </div>
          <div>
            <span className="n">2</span>
            <h3>Answer every 5 minutes</h3>
            <p>
              Each snapshot is a few sentences of grid data from the Grid Status API, using only what was known at that moment.
              The Decisions API returns a probability for each answer instead of text: {stats.calls} snapshots, a median
              of {Math.round(stats.latency_ms.median)} ms each, ${stats.cost_usd.toFixed(3)} for the day.
            </p>
          </div>
          <div>
            <span className="n">3</span>
            <h3>Decide in plain code</h3>
            <p>The rule is checked without a model, with the same 30-minute cooldown as the threshold alert.</p>
            <code className="rule">{d.alert.rule}</code>
            <p className={`small ${parity ? "ok" : "bad"}`}>
              {parity ? "✓ This page recomputed every alert from the model's answers. They match the saved run." : "✗ The recomputed alerts don't match the saved run."}
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2>What didn't work as well</h2>
        <ul className="limits">
          {cut !== null && (
            <li><b>It's close to the line, and jumpy.</b> The alerts came at {pct(Math.min(...semFired.map((i) => prob[i])))}–{pct(Math.max(...semFired.map((i) => prob[i])))} against
              a {pct(cut)} cutoff, and the answer dipped between them while reserves held steady. With the same answers, a 60% cutoff
              alerts {firesAt(0.6)} times, 75% {firesAt(0.75)} times, and 80% {firesAt(0.8) === 1 ? "once" : `${firesAt(0.8)} times`}.</li>
          )}
          <li><b>The same sentence can compile differently.</b> Another run chose a 60% cutoff and alerted 7 times, including at
            7:00 AM, when prices were low. A real product would freeze the compiled alert and show it to the user.</li>
          <li><b>The second question didn't help.</b> It was meant to separate “scarcity approaching” from “demand record only”,
            but it picked “scarcity approaching” during the record afternoon too. The first question did the real work.</li>
          <li><b>One day isn't an evaluation.</b> This shows the idea on a day where a threshold is known to mislead. It doesn't
            measure accuracy. <a href="https://github.com/Castaldo327/grid-semantic-alerts/blob/main/FINDINGS.md">Full findings</a></li>
        </ul>
      </section>

      <div className="cta">
        <div>
          <h2>Try your own alert</h2>
          <p>Write an alert as a sentence, pick any week from December 2025 to October 2026, and run it with your own OpenAI key.</p>
        </div>
        <a className="btn" href={`${BASE}try/`}>Try it</a>
      </div>
    </>
  );
}

export default function App() {
  const [d, setD] = useState<Demo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE}demo/index.json`).then((r) => r.json())
      .then(async ([entry]: IndexEntry[]) => setD(await fetch(`${BASE}${entry.file}`).then((r) => r.json())))
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <Shell page="story" footer={
      <>
        <p>Data from the Grid Status API{d ? ` (${d.datasets.join(", ")})` : ""}. Times are US Central. <a href={d?.scenario.blog_url ?? "https://blog.gridstatus.io"}>Grid Status's write-up of the day</a>.</p>
        <p>Model: OpenAI gpt-6-luna, through the Decisions API for answers and the Responses API for the questions and notes. This page replays a saved run and makes no API calls.</p>
      </>
    }>
      {err && <p className="bad">Couldn't load the data: {err}</p>}
      {!d && !err && <p className="muted hero">Loading…</p>}
      {d && <Story d={d} />}
    </Shell>
  );
}
