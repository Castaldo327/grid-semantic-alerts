// The "pull" step's picture, in place of the notification settings: the Grid Status datasets coming in, then
// the week they make up, Aug 20–26, 2026, a heat wave in which ordinary threshold alerts on the grid's own
// readings (prices, reserves, demand) fired 13 times. Each is checked against the month before the week
// (scripts/abnormal_run.ts): verified abnormal if it went beyond anything in that month, routine if not.
// Weather tags (temperature) are left out: they're the grid's input, not its behavior. Each day shows its
// demand with a dot at the hour of each crossing, solid for verified and hollow for routine; hovering a day
// shows them in a brief below.

import { useEffect, useState, type CSSProperties } from "react";
import type { DayTag } from "./explore/data";
import { Curve, range, useRun, useWeek, type Reading } from "./ercot";
import { Icon } from "./ui";

const START = "2026-08-20";
const PULL_MS = 2700; // how long the datasets take to come in before the week appears

// Tabler icons for each kind of unusual reading (pipeline/08_range_state.py).
const KIND: Record<string, string[]> = {
  reserves: ["M6 7h11a2 2 0 0 1 2 2v.5a.5 .5 0 0 0 .5 .5a.5 .5 0 0 1 .5 .5v3a.5 .5 0 0 1 -.5 .5a.5 .5 0 0 0 -.5 .5v.5a2 2 0 0 1 -2 2h-11a2 2 0 0 1 -2 -2v-6a2 2 0 0 1 2 -2", "M7 10l0 4"],
  price: ["M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2", "M12 3v3m0 12v3"],
  reserve_price: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1", "M12 7v10"],
  demand: ["M3 17l6 -6l4 4l8 -8", "M14 7l7 0l0 7"],
  heat: ["M4 13.5a4 4 0 1 0 4 0v-8.5a2 2 0 1 0 -4 0v8.5", "M4 9h4", "M13 16a4 4 0 1 0 0 -8a4.07 4.07 0 0 0 -1 .124", "M13 3v1", "M21 12h1", "M13 20v1", "M19.4 5.6l-.7 .7", "M18.7 17.7l.7 .7"],
  negative: ["M7 7l10 10", "M17 8l0 9l-9 0"],
  wind: ["M5 8h8.5a2.5 2.5 0 1 0 -2.34 -3.24", "M3 12h15.5a2.5 2.5 0 1 1 -2.34 3.24", "M4 16h5.5a2.5 2.5 0 1 1 -2.34 3.24"],
};
const FREEZE = ["M12 2v20", "M4 6l16 12", "M20 6L4 18"];
const DOWNLOAD = ["M19 18a3.5 3.5 0 0 0 0 -7h-1a5 4.5 0 0 0 -11 -2a4.6 4.4 0 0 0 -2.1 8.4", "M12 13l0 9", "M9 19l3 3l3 -3"];
const CHECK = ["M5 12l5 5l10 -10"];

/** The hour a reading's text gives ("… around 11 PM"), if any. */
function hourOf(t: DayTag): number | null {
  const m = /around (\d{1,2}) (AM|PM)/.exec(t.text);
  return m ? (Number(m[1]) % 12) + (m[2] === "PM" ? 12 : 0) : null;
}
/** The grid's own readings; temperature tags are weather, left out. */
const GRID = new Set(["reserves", "price", "reserve_price", "demand", "negative", "wind"]);
const gridTags = (tags: DayTag[]) => tags.filter((t) => GRID.has(t.kind));
const weekday = (date: string, style: "short" | "long") => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: style, timeZone: "UTC" });

export default function WeekPull({ active }: { active: boolean }) {
  const week = useWeek(START, active);
  const run = useRun(active);
  const verdict = (date: string, t: DayTag): Reading | undefined => run?.readings.find((r) => r.date === date && r.text === t.text);
  const [shown, setShown] = useState(false); // past the pull, showing the week
  const [mounted, setMounted] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (active) { setMounted(true); return; }
    setShown(false); setHover(null);
    const t = setTimeout(() => setMounted(false), 350);
    return () => clearTimeout(t);
  }, [active]);
  useEffect(() => {
    if (!active || !week) return;
    const t = setTimeout(() => setShown(true), PULL_MS);
    return () => clearTimeout(t);
  }, [active, week]);

  const [lo, hi] = week ? range(week.loads) : [0, 1];
  const total = week ? week.days.reduce((n, d) => n + gridTags(d.tags).length, 0) : 0;
  const nVerified = run ? run.readings.filter((r) => r.verified).length : 0;
  const verifiedOn = (date: string) => (run ? run.readings.filter((r) => r.date === date && r.verified).length : 0);
  // Until a day is hovered, brief the one with the most verified abnormalities (the latest, on a tie).
  const busiest = week ? week.days.reduce((b, d, k) => (verifiedOn(d.date) >= verifiedOn(week.days[b].date) ? k : b), 0) : 0;
  const k = hover ?? busiest;
  const day = week?.days[k];

  return (
    <div className={`timeline wk${active ? " on" : ""}`} aria-hidden={!active}>
      {mounted && week && run && <>
        <div className="tl-head">
          <span className="tl-title">ERCOT, Aug 20 – 26, 2026</span>
          <span className="tl-crumbs">
            <span>Grid Status API</span>
            <span className="crumb-in">{week.datasets.length} datasets</span>
            {shown && <span className="crumb-in">168 hours</span>}
            {shown && <span className="crumb-in">{total} crossings</span>}
            {shown && <span className="crumb-in"><em className="hot">{nVerified} verified abnormal</em></span>}
          </span>
        </div>

        {!shown ? (
          <div className="wk-pull">
            <div className="wk-pull-head"><Icon d={DOWNLOAD} size={18} stroke={1.75} /><b>api.gridstatus.io</b><span>Aug 20 – 26, 2026 · hourly</span></div>
            <ul>
              {week.datasets.map((name, i) => (
                <li key={name} style={{ "--i": i } as CSSProperties}>
                  <span className="wk-state"><i className="wk-spin" /><span className="wk-ok"><Icon d={CHECK} size={14} stroke={2.25} /></span></span>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <div className="wk-days" onMouseLeave={() => setHover(null)}>
              {week.days.map((d, j) => {
                const tags = gridTags(d.tags);
                const hours = (v: boolean) => [...new Set(tags.filter((t) => !!verdict(d.date, t)?.verified === v).map(hourOf).filter((h): h is number => h !== null))];
                const nv = verifiedOn(d.date);
                return (
                  <button key={d.date} type="button" className={`wk-day${j === k ? " on" : ""}`} data-n={Math.min(nv, 4)}
                    style={{ "--k": j } as CSSProperties} onMouseEnter={() => setHover(j)} onFocus={() => setHover(j)}
                    aria-label={`${weekday(d.date, "long")}, August ${Number(d.date.slice(8))}: ${nv} verified abnormal of ${tags.length} threshold crossings`}>
                    <span className="tl-wd">{weekday(d.date, "short")}</span>
                    <b>{Number(d.date.slice(8))}</b>
                    <Curve loads={week.loads[j]} lo={lo} hi={hi} marks={hours(true)} rings={hours(false)} />
                    <span className="wk-count">{tags.length ? <>{nv > 0 && <><i />{nv}</>}{tags.length - nv > 0 && <><i className="ring" />{tags.length - nv}</>}</> : "—"}</span>
                  </button>
                );
              })}
            </div>

            {day && (
              <div key={day.date} className="wk-brief">
                <div className="wk-brief-head">
                  <b>{weekday(day.date, "long")}, August {Number(day.date.slice(8))}</b>
                  <span>{gridTags(day.tags).length ? `${verifiedOn(day.date)} verified abnormal of ${gridTags(day.tags).length}` : "No thresholds crossed"}</span>
                  {hover === null && <span className="wk-hint">Hover a day</span>}
                </div>
                {gridTags(day.tags).length ? (
                  <ul>
                    {gridTags(day.tags).map((t, i) => {
                      const v = verdict(day.date, t);
                      return (
                        <li key={t.text} className={v?.verified ? "verified" : "routine"} style={{ "--i": i } as CSSProperties}>
                          <span className={`wk-ico ${t.kind}`}><Icon d={KIND[t.kind] ?? FREEZE} size={15} stroke={1.75} /></span>
                          <span className="wk-text">{t.text}</span>
                          <em>{v?.verified ? "Beyond the month before" : "Topped in the month before"}</em>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="wk-quiet">No threshold fired: demand stayed under 90 GW, the hub price under $300 and reserves above 5.5 GW.</p>}
              </div>
            )}
          </>
        )}
      </>}
    </div>
  );
}
