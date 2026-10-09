// Small presentation pieces: the 24-hour alert ribbon on each card, and the guided-tour caption bar.

import { clock, useWidth } from "./chart";

const TZ = "America/Chicago";

/** "20:10" in Central time, for shareable #t= links. */
export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A full day as a thin strip, with a dot at each alert. Click a dot to jump there. */
export function Ribbon({ t, fired, cls, onPick }: { t: string[]; fired: number[]; cls: string; onPick: (i: number) => void }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const pad = 8;
  const x = (i: number) => pad + (i / (t.length - 1)) * (w - pad * 2);
  const hours = [0, 6, 12, 18, 24];
  return (
    <div className="ribbon" ref={ref}>
      <svg width={w} height={34} role="img" aria-label={`${fired.length} alerts across the day`}>
        <line className="ribbon-base" x1={pad} x2={w - pad} y1={12} y2={12} />
        {hours.map((h) => {
          const xi = pad + (h / 24) * (w - pad * 2);
          return (
            <g key={h}>
              <line className="ribbon-tick" x1={xi} x2={xi} y1={8} y2={16} />
              <text className="ribbon-label" x={xi} y={31} textAnchor={h === 0 ? "start" : h === 24 ? "end" : "middle"}>
                {h === 0 || h === 24 ? "12 am" : h === 12 ? "noon" : h === 6 ? "6 am" : "6 pm"}
              </text>
            </g>
          );
        })}
        {fired.map((i) => (
          <g key={i} className={`ribbon-dot ${cls}`} onClick={() => onPick(i)} role="button" aria-label={`Alert at ${clock(t[i])}`}>
            <circle cx={x(i)} cy={12} r={11} className="hit" />
            <circle cx={x(i)} cy={12} r={5} />
          </g>
        ))}
      </svg>
    </div>
  );
}

export interface TourStep {
  idx: number;
  title: string;
  body: string;
}

export function TourBar({ steps, at, onGo, onClose }: { steps: TourStep[]; at: number; onGo: (k: number) => void; onClose: () => void }) {
  const s = steps[at];
  return (
    <div className="tour" role="region" aria-label="Guided tour">
      <div className="tour-head">
        <span className="tour-step">Step {at + 1} of {steps.length}</span>
        <span className="tour-dots">
          {steps.map((_, k) => <button key={k} type="button" className={k === at ? "on" : ""} aria-label={`Go to step ${k + 1}`} onClick={() => onGo(k)} />)}
        </span>
        <button type="button" className="tour-close" onClick={onClose} aria-label="Close the tour">✕</button>
      </div>
      <div className="tour-title">{s.title}</div>
      <p className="tour-body">{s.body}</p>
      <div className="tour-nav">
        <button type="button" onClick={() => onGo(at - 1)} disabled={at === 0}>← Back</button>
        {at < steps.length - 1
          ? <button type="button" className="primary" onClick={() => onGo(at + 1)}>Next →</button>
          : <button type="button" className="primary" onClick={onClose}>Finish</button>}
      </div>
    </div>
  );
}
