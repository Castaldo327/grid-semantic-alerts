// The test run's results, in place of the notification settings (scripts/abnormal_run.ts wrote them to
// public/demo/abnormal_2026-08-20.json). "judge": a scan sweeps the week hour by hour as the Decisions API's
// answers come in, banding the hours it judged abnormal and scoring it against the week's verified grid
// abnormalities (grid readings beyond anything in the month before): each turns caught or missed as the scan
// passes. "notify": the notifications the Responses API wrote for the hours it flagged, under the digest it wrote
// from them, the ones covering a verified abnormality marked so.

import { useEffect, useState, type CSSProperties } from "react";
import { Curve, range, useRun, useWeek, type Run } from "./ercot";
import { Icon } from "./ui";

const START = "2026-08-20";
const SWEEP_MS = 3600; // the whole week's 168 hours, scanned
const SWEEP_AT = 900; // after the panel fades in

const BELL = ["M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6", "M9 17v1a3 3 0 0 0 6 0v-1"];
const SPARKLES = ["M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"];
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const pct = (p: number) => `${Math.round(p * 100)}%`;
/** The model wrote some headlines in title case; show them all in sentence case, keeping acronyms. */
const sentence = (s: string) => s.split(" ").map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ");

export default function Results({ mode }: { mode: "judge" | "notify" | null }) {
  const active = mode !== null;
  const week = useWeek(START, active);
  const run: Run | null = useRun(active);
  const [mounted, setMounted] = useState(false);
  const [t, setT] = useState(0); // hours scanned so far, 0–168

  useEffect(() => {
    if (active) { setMounted(true); return; }
    const id = setTimeout(() => { setMounted(false); setT(0); }, 350);
    return () => clearTimeout(id);
  }, [active]);

  // The sweep, once per showing of the judge view; the notify view starts with the week fully judged.
  useEffect(() => {
    if (mode === "notify") { setT(168); return; }
    if (mode !== "judge" || !run || !week) return;
    let raf = 0;
    const t0 = performance.now() + SWEEP_AT;
    const tick = (now: number) => {
      const f = Math.min(1, Math.max(0, (now - t0) / SWEEP_MS));
      setT(f * 168);
      if (f < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, run, week]);

  const ready = mounted && week && run;
  const [lo, hi] = week ? range(week.loads) : [0, 1];
  const judged = Math.floor(t);
  const flagged = run ? run.p.slice(0, judged).filter((x) => x !== null && x >= run.cutoff).length : 0;
  const done = judged >= 168;
  // The score so far: verified abnormalities the scan has passed, caught or missed, and the model's own
  // flags (episodes) that cover no verified abnormality.
  const verified = run ? run.readings.filter((r) => r.verified) : [];
  const passed = verified.filter((r) => r.k < judged);
  const caught = passed.filter((r) => r.caught).length;
  const covers = (e: { from: number; to: number }) => verified.some((r) => r.k >= e.from && r.k <= e.to);
  const extra = run ? run.episodes.filter((e) => e.to < judged && !covers(e)).length : 0;

  return (
    <div className={`timeline rs${active ? " on" : ""}`} aria-hidden={!active}>
      {ready && <>
        <div className="tl-head">
          <span className="tl-title">{mode === "notify" ? "What the alert sent" : "Decisions API, hour by hour"}</span>
          <span className="tl-crumbs">
            <span>Aug 20 – 26, 2026</span>
            <span className="crumb-in">168 snapshots</span>
            {done && <span className="crumb-in">{flagged} hours flagged</span>}
            {done && mode === "judge" && <span className="crumb-in"><em className="good">{caught} / {verified.length} caught</em></span>}
            {mode === "notify" && <span className="crumb-in">{run.episodes.length} notifications</span>}
          </span>
        </div>

        {mode === "judge" ? (
          <>
            <div className="wk-days rs-days">
              {week.days.map((d, j) => {
                const ps = run.p.slice(j * 24, j * 24 + 24);
                const seen = (h: number) => j * 24 + h < judged;
                const bands = ps.flatMap((x, h) => (x !== null && x >= run.cutoff && seen(h) ? [h] : []));
                const scanning = t >= j * 24 && t < j * 24 + 24;
                const checks = verified.filter((r) => r.date === d.date);
                return (
                  <div key={d.date} className={`wk-day rs-day${bands.length ? " hit" : ""}`} style={{ "--k": j } as CSSProperties}>
                    <span className="tl-wd">{weekday(d.date)}</span>
                    <b>{Number(d.date.slice(8))}</b>
                    <span className="rs-plot">
                      <Curve loads={week.loads[j]} lo={lo} hi={hi} bands={bands} scan={scanning ? t - j * 24 : null} />
                      {checks.map((r) => {
                        const h = r.k - j * 24;
                        const state = r.k < judged ? (r.caught ? "caught" : "missed") : "open";
                        return <i key={r.text} className={`rs-check ${state}`} style={{ left: `min(${4 + (h / 23) * 92}%, 100% - 9px)` }} title={r.text} />;
                      })}
                    </span>
                    <span className="rs-strip" aria-hidden="true">
                      {ps.map((x, h) => <i key={h} style={{ opacity: seen(h) && x !== null ? 0.12 + 0.88 * x : 0 }} className={x !== null && x >= run.cutoff ? "on" : ""} />)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className={`rs-stats${done ? " done" : ""}`}>
              <div className="good"><b>{caught}<small> / {verified.length}</small></b><span>grid abnormalities caught</span></div>
              <div className="hot"><b>{extra}</b><span>flags of its own</span></div>
              <div><b>{run.stats.latency_ms.median}<small> ms</small></b><span>{judged < 168 ? `judging hour ${judged} of 168…` : "median per hour"}</span></div>
              <div><b>${run.stats.cost_usd.toFixed(4)}</b><span>for the whole week</span></div>
            </div>
          </>
        ) : (
          <div className="rs-inbox">
            <div className="rs-digest">
              <div className="rs-digest-head"><Icon d={SPARKLES} size={16} stroke={1.75} /><b>Your week, in brief</b><span>Written with the Responses API</span></div>
              <p>{run.digest}</p>
            </div>
            <ul className="rs-notes">
              {[...run.episodes].reverse().map((e, i) => ( // newest first, as an inbox lists them
                <li key={e.from} style={{ "--i": i } as CSSProperties}>
                  <span className="rs-bell"><Icon d={BELL} size={15} stroke={1.75} /></span>
                  <div>
                    <div className="rs-note-head"><b>{sentence(e.headline)}</b>{covers(e) && <em className="rs-verified">Verified record</em>}<span>{e.at}</span></div>
                    <p>{e.summary}</p>
                  </div>
                  <span className="rs-p" title="The model's probability that the hour was abnormal">{pct(e.p)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </>}
    </div>
  );
}
