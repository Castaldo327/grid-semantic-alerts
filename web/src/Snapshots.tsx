// The "snapshot" step's picture, in place of the notification settings: a week of ERCOT that zooms into a
// day, then an hour, then steps through it five minutes at a time, each step a snapshot sent to the model.
// The week and day are drawn from ERCOT's real hourly demand for Jan 22–28, 2026; the five-minute tiles
// carry a 60 Hz waveform that runs yellow when its snapshot is taken.

import { useEffect, useState, type CSSProperties } from "react";
import { Curve, gw, range, useWeek } from "./ercot";
import { Icon } from "./ui";

const FIRST = "2026-01-22";

/** Two and a half cycles of a sine wave across 0–200, so sliding it by 80 loops seamlessly. */
const WAVE = `M${Array.from({ length: 201 }, (_, x) => `${x} ${(20 - 11 * Math.sin((x / 40) * 2 * Math.PI)).toFixed(2)}`).join(" L")}`;

const DAYS = [["Thu", 22], ["Fri", 23], ["Sat", 24], ["Sun", 25], ["Mon", 26], ["Tue", 27], ["Wed", 28]] as const;
const DAY = 3; // Sunday, Jan 25
const HOUR = 18; // 6 PM
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
const SNAP_MS = 1000;

// Where each zoom goes in, as a transform origin: the picked day's column, then the picked hour's tile.
const WEEK_ORIGIN = `${((DAY + 0.5) / 7) * 100}% 50%`;
const DAY_ORIGIN = `${(((HOUR % 6) + 0.5) / 6) * 100}% ${((Math.floor(HOUR / 6) + 0.5) / 4) * 100}%`;

const CAMERA = ["M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2", "M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"];

export default function Snapshots({ active }: { active: boolean }) {
  const [level, setLevel] = useState(0); // 0 week, 1 day, 2 hour, 3 snapshots running
  const [picking, setPicking] = useState(false);
  const [snap, setSnap] = useState(0);
  const week = useWeek(FIRST, active)?.loads ?? null;
  // Mount the scenes only while shown (and through the fade-out), so their entrances play on screen.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (active) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), 350);
    return () => clearTimeout(t);
  }, [active]);
  const [lo, hi] = week ? range(week) : [0, 1];
  const today = week?.[DAY] ?? [];
  const dLo = Math.min(...today), dHi = Math.max(...today);

  // The zoom sequence: show the week, pick a day and zoom in, pick an hour and zoom in, then start snapping.
  useEffect(() => {
    setLevel(0); setPicking(false);
    if (!active) return;
    const steps: [number, () => void][] = [
      [2900, () => setPicking(true)], [3500, () => { setLevel(1); setPicking(false); }],
      [5300, () => setPicking(true)], [5900, () => { setLevel(2); setPicking(false); }],
      [6700, () => setLevel(3)],
    ];
    const ts = steps.map(([ms, f]) => setTimeout(f, ms));
    return () => ts.forEach(clearTimeout);
  }, [active]);

  useEffect(() => {
    setSnap(0);
    if (level < 3) return;
    const t = setInterval(() => setSnap((s) => (s + 1) % 12), SNAP_MS);
    return () => clearInterval(t);
  }, [level]);

  const scene = (k: number) => (level > k && k < 2 ? "tl-past" : Math.min(level, 2) === k ? "tl-now" : "tl-next");
  const time = `6:${String(snap * 5).padStart(2, "0")} PM`;

  return (
    <div className={`timeline${active ? " on" : ""}`} aria-hidden={!active}>
      {mounted && <>
      <div className="tl-head">
        <span className="tl-title">ERCOT demand, every five minutes</span>
        <span className="tl-crumbs">
          <span>Jan 22 – 28, 2026</span>
          {level >= 1 && <span className="crumb-in">Sun, Jan 25</span>}
          {level >= 2 && <span className="crumb-in">6 PM</span>}
          {level >= 3 && <span className="crumb-in"><em className="snap">every 5 min</em></span>}
        </span>
      </div>

      <div className="tl-scenes">
        <div className={`tl-scene week ${scene(0)}`} style={{ transformOrigin: WEEK_ORIGIN }}>
          {DAYS.map(([wd, d], k) => (
            <div key={d} className={`tl-day${k === DAY && picking && level === 0 ? " pick" : ""}`} style={{ animationDelay: `${k * 60}ms`, "--k": k } as CSSProperties}>
              <span className="tl-wd">{wd}</span><b>{d}</b>
              {week && <Curve loads={week[k]} lo={lo} hi={hi} />}
              <span className="tl-peak">{week ? `${Math.round(Math.max(...week[k].filter(Number.isFinite)) / 1000)} GW` : ""}<small>peak</small></span>
            </div>
          ))}
        </div>

        <div className={`tl-scene day ${scene(1)}`} style={{ transformOrigin: DAY_ORIGIN }}>
          {Array.from({ length: 24 }, (_, h) => {
            const v = today[h];
            const fill = Number.isFinite(v) ? 0.38 + (0.24 * (v - dLo)) / (dHi - dLo) : 0; // above the reading, below the hour label
            return (
              <div key={h} className={`tl-hour${h === HOUR && picking && level === 1 ? " pick" : ""}${v === dHi ? " peak" : ""}`}
                style={{ "--fill": fill, "--k": h } as CSSProperties}>
                <span>{hourLabel(h)}</span>
                {Number.isFinite(v) && <small>{gw(v)}</small>}
              </div>
            );
          })}
        </div>

        <div className={`tl-scene hour ${scene(2)}`}>
          {Array.from({ length: 12 }, (_, k) => (
            <div key={k} className={`tl-five${level === 3 && k === snap ? " snapping" : ""}${level === 3 && k < snap ? " taken" : ""}`}>
              <svg className="tl-wave" viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
                <path d={WAVE} vectorEffect="non-scaling-stroke" style={{ animationDelay: `${-k * 0.4}s` }} />
              </svg>
              <span className="tl-time">6:{String(k * 5).padStart(2, "0")}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`tl-card${level === 3 ? " on" : ""}`}>
        <div key={snap} className="tl-shot">
          <span className="tl-cam"><Icon d={CAMERA} size={18} stroke={1.75} /></span>
          <span className="tl-shot-text">
            <b>{time} snapshot</b>
            <span>Prices · load · reserves · wind · solar · weather</span>
          </span>
          <span className="tl-arrow" aria-hidden="true" />
          <span className="tl-model">System 1</span>
          <span className="tl-answers"><code>abnormal</code><code>not_abnormal</code></span>
        </div>
      </div>
      </>}
    </div>
  );
}
