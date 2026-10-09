import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Panel, makeX, useWidth, type Tick } from "./chart";
import { cooldown, cutoffs, evaluate, parse, thresholdHit } from "./rule";
import { AlertCol, Answers, BASE, ChartIcon, Field, Mail, Quiet, Section, Shell, ThresholdCheck, gw, orNA, pct, usd } from "./site";
import type { Demo, IndexEntry } from "./types";

const TZ = "America/Chicago";
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
/** "20:10" in Central time, for #t= links. */
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const gwTick = (v: number) => `${Math.round(v / 1000)}`;

// The July 22 threshold alert in the alert form's own terms.
const OP_LABEL: Record<string, string> = { ">": "Greater than", ">=": "Greater than or equal to", "<": "Less than", "<=": "Less than or equal to" };
const SERIES_LABEL: Record<string, string> = { load_mw: "ERCOT Load: load" };
const THRESHOLD_NAME = "ERCOT load above 90 GW";
const SENTENCE_NAME = "ERCOT scarcity watch";

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
      body: `The threshold alert notifies you. The model puts the chance that ERCOT is heading toward scarcity at ${P(a)}: reserves are ${v("prc_mw", a, gw)} and the hub price is ${v("hub_rt_price", a, mwh)}.` },
    { idx: b, title: "An all-time record",
      body: `Demand peaks at ${v("load_mw", b, gw)}. The threshold alert has notified you ${thrFired.filter((i) => i <= b).length} times and repeats every 30 minutes. The sentence alert stays quiet at ${P(b)}, because reserves are still ${v("prc_mw", b, gw)}.` },
    { idx: f, title: "The sentence alert fires",
      body: `Solar is down to ${v("solar_mw", f, gw)}, batteries are covering ${v("battery_discharge_mw", f, gw)}, and reserves have fallen to ${v("prc_mw", f, gw)}. The model's answer reaches ${P(f)}. The threshold alert is silent: demand has dropped to ${v("load_mw", f, gw)}.` },
    { idx: m, title: "A weak spot",
      body: `Reserves are still near ${v("prc_mw", m, gw)}, but the model's answer has fallen back to ${P(m)}.${next !== undefined ? ` It doesn't fire again until ${clock(d.t[next])}.` : ""} The answer is jumpy from one row to the next.` },
    { idx: z, title: "The tightest moment",
      body: `The hub price hits ${v("hub_rt_price", z, mwh)}, non-spinning reserve ${v("nspin_price", z, mwh)}, and reserves are down to ${v("prc_mw", z, gw)}. The model says ${P(z)}.${last !== undefined && last !== z ? ` No new notification: the last one, at ${clock(d.t[last])}, is inside the 30-minute timeout.` : ""}` },
  ];
}

function Outcome({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="outcome">
      <div className="outcome-n">{n} <small>notification{n === 1 ? "" : "s"}</small></div>
      <p>{children}</p>
    </div>
  );
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

  // Every notification is recomputed here from the model's answers, and checked against the pipeline's run.
  const ruleTrue = useMemo(() => d.decisions.map((a) => evaluate(tree, a, d.alert.questions)), [d, tree]);
  const thrTrue = useMemo(() => s[thr.series].map((v) => thresholdHit(thr, v)), [s, thr]);
  const semFired = useMemo(() => cooldown(ruleTrue, d.t, d.cooldown_minutes), [ruleTrue, d]);
  const thrFired = useMemo(() => cooldown(thrTrue, d.t, d.cooldown_minutes), [thrTrue, d]);
  const parity = JSON.stringify([semFired, thrFired, ruleTrue]) === JSON.stringify([d.fired.semantic, d.fired.threshold, d.rule_true]);

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
  const when = `${clock(d.t[idx])} CT, Jul 22`;
  const stats = d.decision_stats;
  const between = (idxs: number[]) => (idxs.length ? `${clock(d.t[idxs[0]])} to ${clock(d.t[idxs[idxs.length - 1]])}` : "");
  const prcAt = (idxs: number[]) => idxs.map((i) => s.prc_mw[i]).filter((v): v is number => v !== null);
  const range = (vals: number[]) => `${(Math.min(...vals) / 1000).toFixed(1)}–${(Math.max(...vals) / 1000).toFixed(1)} GW`;
  // How low reserves went after the threshold alert's last notification.
  const lowAfter = Math.min(...prcAt(d.t.map((_, i) => i).filter((i) => i > thrFired[thrFired.length - 1])));
  const thrValue = (x: number) => Math.round(x).toLocaleString("en-US");
  const thrMW = (x: number) => `${thrValue(x)} MW`;

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Proposed enhancement to Grid Status alerts</p>
        <h1>Alerts that check what you mean</h1>
        <p className="lede">
          Today an alert watches one series against one value. This adds a second option: describe the condition in a sentence,
          and get notified only when it's true.
        </p>
      </header>

      <div className="card" id="replay">
        <Section title="Replay: July 22, 2026" help={<>
          ERCOT set an all-time demand record at 4:55 PM, but the grid didn't get tight until the evening. Here is the same worry
          set up both ways, checked on every 5-minute row of the day. <a href={d.scenario.blog_url}>Grid Status's write-up of the day</a>
        </>}>
          <div className="compare">
            <div className="option">
              <div className="option-head"><span className="key-dot thr" />Threshold<span className="muted">· available today</span></div>
              <div className="series-row">
                <Field label="Select Series"><div className="input locked"><span>{SERIES_LABEL[thr.series] ?? thr.series}</span><ChartIcon /></div></Field>
                <Field label="Is"><div className="input locked"><span>{OP_LABEL[thr.op]}</span></div></Field>
                <Field label="Value"><div className="input locked"><span>{thr.value}</span></div></Field>
              </div>
              <Outcome n={thrFired.length}>
                {between(thrFired)}, while reserves were {range(prcAt(thrFired))}. None after that, as reserves fell
                to {gw(lowAfter)} in the evening.
              </Outcome>
            </div>
            <div className="option">
              <div className="option-head"><span className="key-dot sem" />Describe it<span className="badge">New</span></div>
              <Field label="Describe the condition"><div className="input locked tall">{d.alert.sentence}</div></Field>
              <Outcome n={semFired.length}>
                {between(semFired)}, as reserves fell from {orNA(s.prc_mw[semFired[0]], gw)} to {orNA(s.prc_mw[semFired[semFired.length - 1]], gw)}.
                None during the record afternoon.
              </Outcome>
            </div>
          </div>
          <p className="key-note">
            Both alerts use a {d.cooldown_minutes}-minute Notification Timeout. In the charts, dots are notifications, shading
            marks rows where the condition held, and the dashed line is where each alert notifies.
          </p>

          <div className="panels" ref={ref}>
            <Panel X={X} idx={idx} pinned={pinned} onHover={setHover} onPick={pin} label="ERCOT load through the day, with the threshold and its notifications"
              title={<><span className="key-dot thr" />Threshold <span className="muted">· ERCOT Load: load, GW, notifies above {thr.value / 1000}</span></>} value={orNA(s.load_mw[idx], gw)}
              values={s.load_mw} yFmt={gwTick} height={92} shade={thrTrue} tone="thr" markers={thrFired}
              markerLabel={(i) => `Threshold notification at ${clock(d.t[i])}`}
              refLine={{ value: thr.value, tone: "thr" }} />
            <Panel X={X} idx={idx} pinned={pinned} onHover={setHover} onPick={pin} label="The model's answer through the day, with the cutoff and notifications"
              title={<><span className="key-dot sem" />Describe it <span className="muted">· the model's answer to “{primary.text}”{cut !== null ? `, notifies at ${pct(cut)}` : ""}</span></>} value={pct(prob[idx])}
              values={prob} domain={[0, 1]} ticks={[0, 0.5, 1]} yFmt={pct} height={92} color="var(--sem)" shade={ruleTrue} tone="sem" markers={semFired}
              markerLabel={(i) => `Sentence notification at ${clock(d.t[i])}`}
              refLine={cut !== null ? { value: cut, tone: "sem" } : undefined} />
            <Panel X={X} idx={idx} onHover={setHover} onPick={pin} label="Operating reserves through the day"
              title={<>ERCOT PRC: prc, GW <span className="muted">· operating reserves; lower is tighter</span></>} value={orNA(s.prc_mw[idx], gw)}
              values={s.prc_mw} yFmt={gwTick} height={60} axis={hourTicks} />
          </div>

          <div className="moments" role="group" aria-label="Moments of the day">
            {steps.map((m, k) => (
              <button key={k} type="button" className="moment" aria-pressed={k === moment} onClick={() => pin(m.idx)}>
                <b>{clock(d.t[m.idx])}</b>{m.title}
              </button>
            ))}
          </div>

          <div className="inspect" aria-live="polite">
            <div className="inspect-head">
              <h3 className="inspect-time">{clock(d.t[idx])}{moment >= 0 && <> <span>{steps[moment].title}</span></>}</h3>
              <div className="facts">
                <span>Demand <b>{orNA(s.load_mw[idx], gw)}</b></span>
                <span>Reserves <b>{orNA(s.prc_mw[idx], gw)}</b></span>
                <span>Hub price <b>{orNA(s.hub_rt_price[idx], (x) => `${usd(x)}/MWh`)}</b></span>
              </div>
            </div>
            {moment >= 0 && <p className="narrative">{steps[moment].body}</p>}
            <div className="cols">
              <AlertCol tone="thr">
                {thrSent
                  ? <Mail tone="thr" name={THRESHOLD_NAME} when={when}>
                      {SERIES_LABEL[thr.series] ?? thr.series} is {orNA(s[thr.series][idx], thrValue)}, {OP_LABEL[thr.op].toLowerCase()} {thr.value}.
                    </Mail>
                  : <Quiet>{thrTrue[idx] ? "Over the line, but inside the 30-minute timeout: no new notification." : "No notification."}</Quiet>}
                <ThresholdCheck label={SERIES_LABEL[thr.series] ?? thr.series} value={orNA(s[thr.series][idx], thrMW)}
                  met={thrTrue[idx]} needs={`${OP_LABEL[thr.op].toLowerCase()} ${thr.value}`} />
              </AlertCol>
              <AlertCol tone="sem">
                {semSent
                  ? <Mail tone="sem" name={SENTENCE_NAME} when={when}>{ex?.kind === "fired" ? ex.text : `${primary.text} ${pct(prob[idx])} yes.`}</Mail>
                  : <Quiet>{ruleTrue[idx] ? "Rule met, but inside the 30-minute timeout: no new notification." : "No notification."}</Quiet>}
                {ex?.kind === "declined" && (
                  <p className="why"><span className="muted">Why it stayed quiet, in gpt-6-luna's words: </span>{ex.text}</p>
                )}
                <Answers questions={d.alert.questions} answers={d.decisions[idx]} tree={tree} />
                <details className="read">
                  <summary>What the model read</summary>
                  <p>{d.prose[idx]}</p>
                </details>
              </AlertCol>
            </div>
          </div>
        </Section>
      </div>

      <div className="card">
        <Section title="How it works" help="The sentence becomes questions once, when the alert is saved. After that, each new row costs one fast model call, and the decision is plain code.">
          <div className="how">
            <div>
              <span className="n">1</span>
              <h3>Describe it once</h3>
              <p>gpt-6-luna turns the sentence into questions and a rule. A validator rejects anything that doesn't fit, such as a rule that wouldn't exclude “just setting demand records.”</p>
              <ul>{d.alert.questions.map((q) => <li key={q.id}>{q.text}</li>)}</ul>
            </div>
            <div>
              <span className="n">2</span>
              <h3>Check every new row</h3>
              <p>
                Each row becomes a few sentences of grid data, using only what was known at that moment. OpenAI's Decisions
                API answers with probabilities instead of text.
              </p>
              <div className="stats">
                <div><b>{Math.round(stats.latency_ms.median)} ms</b><span>median per row</span></div>
                <div><b>${stats.cost_usd.toFixed(3)}</b><span>for all {stats.calls} rows of July 22</span></div>
              </div>
            </div>
            <div>
              <span className="n">3</span>
              <h3>Notify in plain code</h3>
              <p>The rule and the Notification Timeout decide, with no model involved. A sentence alert can also say why it fired, in one line written from the same row.</p>
              <code className="rule">{d.alert.rule}</code>
              <p className={`small ${parity ? "ok" : "bad"}`} style={{ marginTop: 8 }}>
                {parity ? "✓ This page recomputed every notification from the model's answers. They match the saved run." : "✗ The recomputed notifications don't match the saved run."}
              </p>
            </div>
          </div>
        </Section>
      </div>

      <div className="card cta">
        <div>
          <h2 className="section-title">Try it in the alert form</h2>
          <p>Describe your own condition, pick any week from December 2025 to October 2026, and see when it would have notified you, next to a threshold.</p>
        </div>
        <a className="btn" href={`${BASE}try/`}>Create an alert</a>
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
    <Shell page="overview" footer={
      <>
        <p>Data from the Grid Status API{d ? ` (${d.datasets.join(", ")})` : ""}. Times are US Central.</p>
        <p>Model: OpenAI gpt-6-luna, through the Decisions API for answers and the Responses API for the questions and notification text. This page replays a saved run and makes no API calls.</p>
      </>
    }>
      {err && <p className="bad page-head">Couldn't load the data: {err}</p>}
      {!d && !err && <p className="muted page-head">Loading…</p>}
      {d && <Story d={d} />}
    </Shell>
  );
}
