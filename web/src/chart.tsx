// Hand-rolled SVG time-series panels on one shared x axis. One index (the scrubber) drives the
// crosshair in every panel; the legend doubles as the value readout at that index.

import { useEffect, useRef, useState, type ReactNode } from "react";

export const MARGIN = { left: 52, right: 14 };
const TZ = "America/Chicago";

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface XScale {
  x: (i: number) => number;
  invert: (px: number) => number;
  width: number;
  n: number;
}

export function makeX(t: string[], width: number): XScale {
  const ms = t.map((s) => Date.parse(s));
  const t0 = ms[0];
  const span = 24 * 3600_000;
  const inner = width - MARGIN.left - MARGIN.right;
  const step = 5 * 60_000;
  return {
    x: (i) => MARGIN.left + ((ms[i] - t0) / span) * inner,
    invert: (px) => Math.max(0, Math.min(ms.length - 1, Math.round((((px - MARGIN.left) / inner) * span) / step))),
    width,
    n: ms.length,
  };
}

export const clock = (iso: string, withMin = true) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", ...(withMin ? { minute: "2-digit" } : {}) });

export interface Series {
  key: string;
  label: string;
  color: string; // CSS var
  values: (number | null)[];
  format: (v: number) => string;
  note?: string; // e.g. "hourly, forward-filled"
}

interface YScale {
  y: (v: number) => number;
  ticks: number[];
  fmt: (v: number) => string;
}

function niceLinear(min: number, max: number, h: number, top: number, fmt: (v: number) => string, zero: boolean): YScale {
  if (zero) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const raw = (max - min) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return { y: (v) => top + h - ((v - lo) / (hi - lo)) * h, ticks, fmt };
}

function niceLog(min: number, max: number, h: number, top: number, fmt: (v: number) => string): YScale {
  const lo = Math.floor(Math.log10(Math.max(1, min)));
  const hi = Math.ceil(Math.log10(max));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) ticks.push(10 ** e);
  return { y: (v) => top + h - ((Math.log10(Math.max(10 ** lo, v)) - lo) / (hi - lo || 1)) * h, ticks, fmt };
}

function path(values: (number | null)[], X: XScale, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || Number.isNaN(v)) { pen = false; return; }
    d += `${pen ? "L" : "M"}${X.x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function XAxis({ t, X, top }: { t: string[]; X: XScale; top: number }) {
  const ticks = t.map((s, i) => [s, i] as const).filter(([s]) => {
    const h = Number(new Date(s).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false }));
    const m = new Date(s).getUTCMinutes();
    return m === 0 && h % (X.width < 560 ? 6 : 3) === 0;
  });
  return (
    <g className="axis">
      {ticks.map(([s, i]) => (
        <text key={s} x={X.x(i)} y={top + 14} textAnchor="middle">{clock(s, false).replace(" ", " ").toLowerCase()}</text>
      ))}
    </g>
  );
}

/** Pointer layer: hovering or dragging anywhere on a panel moves the shared index. */
export function HitLayer({ X, height, onIdx }: { X: XScale; height: number; onIdx: (i: number) => void }) {
  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    onIdx(X.invert(e.clientX - r.left));
  };
  return (
    <rect x={MARGIN.left} y={0} width={X.width - MARGIN.left - MARGIN.right} height={height} fill="transparent"
      style={{ touchAction: "pan-y", cursor: "crosshair" }} onPointerMove={move} onPointerDown={move} />
  );
}

export function Crosshair({ X, idx, top, bottom }: { X: XScale; idx: number; top: number; bottom: number }) {
  const x = X.x(idx);
  return <line className="crosshair" x1={x} x2={x} y1={top} y2={bottom} />;
}

export function Legend({ series, idx, hidden, onToggle }: {
  series: Series[]; idx: number; hidden?: Set<string>; onToggle?: (k: string) => void;
}) {
  return (
    <div className="legend" role="group">
      {series.map((s) => {
        const v = s.values[idx];
        const off = hidden?.has(s.key);
        return (
          <button key={s.key} type="button" className={`key${off ? " off" : ""}`} aria-pressed={!off}
            onClick={onToggle ? () => onToggle(s.key) : undefined} disabled={!onToggle}
            title={s.note ? `${s.label} (${s.note})` : s.label}>
            <span className="swatch" style={{ background: s.color }} />
            <span className="key-label">{s.label}{s.note ? "*" : ""}</span>
            <span className="key-value">{v === null || v === undefined ? "n/a" : s.format(v)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function LinePanel({ title, t, X, series, idx, onIdx, height = 150, log = false, yFmt, zero = true, hidden, onToggle, children }: {
  title: string; t: string[]; X: XScale; series: Series[]; idx: number; onIdx: (i: number) => void;
  height?: number; log?: boolean; yFmt: (v: number) => string; zero?: boolean;
  hidden?: Set<string>; onToggle?: (k: string) => void;
  children?: (y: (v: number) => number) => ReactNode;
}) {
  const top = 8;
  const plotH = height - top - 22;
  const shown = series.filter((s) => !hidden?.has(s.key));
  const vals = shown.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const Y = log ? niceLog(min, max, plotH, top, yFmt) : niceLinear(min, max, plotH, top, yFmt, zero);
  return (
    <figure className="panel">
      <figcaption>
        <span className="panel-title">{title}</span>
        <Legend series={series} idx={idx} hidden={hidden} onToggle={onToggle} />
      </figcaption>
      <svg width={X.width} height={height} role="img" aria-label={title}>
        <g className="grid">
          {Y.ticks.map((v) => (
            <g key={v}>
              <line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={Y.y(v)} y2={Y.y(v)} />
              <text x={MARGIN.left - 6} y={Y.y(v) + 3.5} textAnchor="end">{Y.fmt(v)}</text>
            </g>
          ))}
        </g>
        {children?.(Y.y)}
        {shown.map((s) => (
          <path key={s.key} d={path(s.values, X, Y.y)} className="series" style={{ stroke: s.color }} />
        ))}
        <Crosshair X={X} idx={idx} top={top} bottom={top + plotH} />
        {shown.map((s) => {
          const v = s.values[idx];
          return v === null || v === undefined ? null : (
            <circle key={s.key} cx={X.x(idx)} cy={Y.y(v)} r={4} className="dot" style={{ fill: s.color }} />
          );
        })}
        <XAxis t={t} X={X} top={top + plotH} />
        <HitLayer X={X} height={height} onIdx={onIdx} />
      </svg>
    </figure>
  );
}
