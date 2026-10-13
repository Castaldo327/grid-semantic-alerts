// The demo's close, in place of the notification settings. "cost": what one alert costs a year at 1-, 5- and
// 10-minute snapshots, from the test run's measured tokens (public/demo/abnormal_2026-08-20.json) at
// gpt-6-luna's prices. "value": what it unlocks, and how it did on the real week.

import { useEffect, useState, type CSSProperties } from "react";
import { useRun, type Run } from "./ercot";
import { EMAIL, Icon } from "./ui";

// gpt-6-luna's API prices, per million tokens (OpenAI's published pricing, Oct 2026).
const USD_IN = 0.1, USD_OUT = 0.5;
const MINUTES_A_YEAR = 525_600;
const WEEKS = 52;

/** One alert's yearly cost at a given cadence, from the run: a judgment per snapshot, plus a notification
 *  for every episode at the test week's pace (a heat wave, so generous) and a digest each week. */
function yearly(run: Run, minutes: number) {
  const s = run.stats;
  const judgments = MINUTES_A_YEAR / minutes;
  const judging = judgments * (s.input_tokens / s.calls) * USD_IN / 1e6;
  const perNote = (s.notifications.input_tokens * USD_IN + s.notifications.output_tokens * USD_OUT) / 1e6 / s.notifications.calls;
  const perDigest = (s.digest.input_tokens * USD_IN + s.digest.output_tokens * USD_OUT) / 1e6;
  const notes = run.episodes.length * WEEKS;
  const writing = notes * perNote + WEEKS * perDigest;
  return { judgments, judging, notes: notes + WEEKS, writing, total: judging + writing };
}

const usd = (x: number, d = 2) => `$${x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/** A number that counts up from zero once shown. */
function CountUp({ to, format, delay = 0 }: { to: number; format: (x: number) => string; delay?: number }) {
  const [x, setX] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const f = Math.min(1, Math.max(0, (now - t0) / 1400));
      setX(to * (1 - Math.pow(1 - f, 3)));
      if (f < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, delay]);
  return <>{format(x)}</>;
}

const CADENCES = [
  { minutes: 1, label: "Every minute" },
  { minutes: 5, label: "Every 5 minutes", note: "ERCOT’s market interval" },
  { minutes: 10, label: "Every 10 minutes" },
];

const SPARKLES = ["M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"];
const BOLT = ["M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"];
const TARGET = ["M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0", "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"];

export default function Wrap({ mode }: { mode: "cost" | "value" | null }) {
  const active = mode !== null;
  const run = useRun(active);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (active) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), 350);
    return () => clearTimeout(t);
  }, [active]);

  const max = run ? yearly(run, 1).total : 1;
  const caught = run ? run.readings.filter((r) => r.verified && r.caught).length : 0;
  const verified = run ? run.readings.filter((r) => r.verified).length : 0;
  const five = run ? yearly(run, 5).total : 0;

  const pillars = run ? [
    { icon: SPARKLES, title: "For customers", items: ["Describe a situation in a sentence", "One alert instead of a stack of thresholds", "Every notification explains itself"] },
    { icon: BOLT, title: "For Grid Status", items: ["A new kind of alert on data it already has", "Any dataset becomes something to ask about", "Cheap enough to run on every user’s alert"] },
    { icon: TARGET, title: "On a real week", items: [`Caught ${caught} of ${verified} verified grid abnormalities, each at 99%`, "Quiet through record heat and 90 GW afternoons", `${run.stats.latency_ms.median} ms an hour, about ${usd(five, 0)} a year`] },
  ] : [];

  return (
    <div className={`timeline wr${active ? " on" : ""}`} aria-hidden={!active}>
      {mounted && run && (mode === "cost" ? (
        <>
          <div className="tl-head">
            <span className="tl-title">One alert, all year</span>
            <span className="tl-crumbs">
              <span>{run.model}</span>
              <span className="crumb-in">{usd(USD_IN)} per 1M tokens in</span>
              <span className="crumb-in">{usd(USD_OUT)} per 1M out</span>
            </span>
          </div>
          <div className="wr-cards">
            {CADENCES.map((c, i) => {
              const y = yearly(run, c.minutes);
              return (
                <div key={c.minutes} className={`wr-card${c.minutes === 5 ? " pick" : ""}`} style={{ "--i": i } as CSSProperties}>
                  <span className="wr-cadence">{c.label}</span>
                  {c.note && <span className="wr-note">{c.note}</span>}
                  <b className="wr-total"><CountUp to={y.total} format={(x) => usd(x)} delay={600 + i * 150} /><small>/year</small></b>
                  <span className="wr-bar"><i style={{ width: `${(y.total / max) * 100}%` }} /></span>
                  <dl>
                    <div><dt>{Math.round(y.judgments).toLocaleString("en-US")} judgments</dt><dd>{usd(y.judging)}</dd></div>
                    <div><dt>{y.notes.toLocaleString("en-US")} write-ups</dt><dd>{usd(y.writing)}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="wr-scale">
            <div><b><CountUp to={five * 1000} format={(x) => usd(x, 0)} delay={1300} /></b><span>a thousand customers’ alerts, every 5 minutes, for a year</span></div>
            <div><b>{usd(yearly(run, 60).total)}</b><span>hourly, as tested on the heat wave</span></div>
          </div>
          <p className="wr-foot">
            Measured on the test run: {Math.round(run.stats.input_tokens / run.stats.calls)} tokens per judgment, and a notification for each of the week’s {run.episodes.length} episodes every week, a heat wave’s pace. Assumes a snapshot the same size at every cadence.
          </p>
        </>
      ) : (
        <>
          <div className="tl-head">
            <span className="tl-title">What this unlocks</span>
            <span className="tl-crumbs"><span>Fast judgment</span><span className="crumb-in">structured answers</span><span className="crumb-in">plain-code decisions</span></span>
          </div>
          <div className="wr-pillars">
            {pillars.map((p, i) => (
              <div key={p.title} className="wr-pillar" style={{ "--i": i } as CSSProperties}>
                <span className="wr-icon"><Icon d={p.icon} size={18} stroke={1.75} /></span>
                <b>{p.title}</b>
                <ul>{p.items.map((x, j) => <li key={x} style={{ "--j": j } as CSSProperties}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className="wr-sign">
            <span>Built on Grid Status data with gpt-6-luna’s Decisions API.</span>
            <a href={`mailto:${EMAIL}`}>{EMAIL}</a>
          </div>
        </>
      ))}
    </div>
  );
}
