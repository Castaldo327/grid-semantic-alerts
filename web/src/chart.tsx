// Small SVG time-series panels stacked on one shared x axis. One index drives the crosshair in every
// panel: hovering moves it, clicking pins it. The Overview page uses 288 five-minute points, the
// Create alert page 168 hourly ones.

import { useEffect, useRef, useState, type ReactNode } from "react";

export const M = { left: 40, right: 8 };
const MARK = 16; // marker lane above the plot when a panel has firing markers
const R = 4.5; // marker radius

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
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
  step: number;
}

export function makeX(n: number, width: number): XScale {
  const step = (width - M.left - M.right) / Math.max(1, n - 1);
  return {
    x: (i) => M.left + i * step,
    invert: (px) => Math.max(0, Math.min(n - 1, Math.round((px - M.left) / step))),
    width,
    n,
    step,
  };
}

export interface Tick { i: number; label: string; mark?: boolean; title?: string }

/** Round tick values inside [lo, hi]: the largest round step that still gives at least two. */
function niceTicks(lo: number, hi: number): number[] {
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / 3 || 1));
  for (const m of [10, 5, 2.5, 2, 1, 0.5]) {
    const step = m * mag;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    if (out.length >= 2) return out;
  }
  return [lo, hi];
}

function spans(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let a = -1;
  flags.forEach((f, i) => {
    if (f && a < 0) a = i;
    if (!f && a >= 0) { out.push([a, i - 1]); a = -1; }
  });
  if (a >= 0) out.push([a, flags.length - 1]);
  return out;
}

/** Index runs of consecutive non-null values: a missing value (or a declined answer) breaks the line. */
function runs(vals: (number | null)[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  vals.forEach((v, i) => {
    if (v === null || Number.isNaN(v)) { if (cur.length) out.push(cur); cur = []; } else cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

function linePath(vals: (number | null)[], X: XScale, y: (v: number) => number): string {
  return runs(vals).map((r) => r.length === 1
    ? `M${(X.x(r[0]) - 1).toFixed(1)},${y(vals[r[0]]!).toFixed(1)}h2` // a lone value still shows, as a dot
    : r.map((i, k) => `${k ? "L" : "M"}${X.x(i).toFixed(1)},${y(vals[i]!).toFixed(1)}`).join("")).join("");
}

function bandPath(lo: (number | null)[], hi: (number | null)[], X: XScale, y: (v: number) => number): string {
  let d = "";
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      d += run.map((i, k) => `${k ? "L" : "M"}${X.x(i).toFixed(1)},${y(hi[i]!).toFixed(1)}`).join("");
      d += [...run].reverse().map((i) => `L${X.x(i).toFixed(1)},${y(lo[i]!).toFixed(1)}`).join("") + "Z";
    }
    run = [];
  };
  lo.forEach((v, i) => (v === null || hi[i] === null ? flush() : run.push(i)));
  flush();
  return d;
}

export interface PanelProps {
  X: XScale;
  title: ReactNode;
  value?: ReactNode;
  values: (number | null)[];
  yFmt: (v: number) => string;
  height?: number;
  color?: string;
  band?: [(number | null)[], (number | null)[]];
  domain?: [number, number];
  ticks?: number[];
  refLine?: { value: number; tone: "sem" | "thr" }; // where the alert notifies; its value is labeled in the axis margin
  shade?: boolean[];
  tone?: "sem" | "thr";
  markers?: number[];
  markerLabel?: (i: number) => string;
  dividers?: number[];
  axis?: Tick[];
  idx: number | null;
  pinned?: number | null;
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
  label: string;
}

export function Panel(p: PanelProps) {
  const { X, values, yFmt, idx, tone = "sem" } = p;
  const top = p.markers ? MARK : 4;
  const plotH = p.height ?? 90;
  const bottom = top + plotH;
  const svgH = bottom + (p.axis ? 22 : 4);

  // The data's own range (plus a little air), with round ticks placed inside it.
  let lo: number, hi: number;
  if (p.domain) [lo, hi] = p.domain;
  else {
    const vals = [...values, ...(p.band ? [...p.band[0], ...p.band[1]] : [])].filter((v): v is number => v !== null);
    if (p.refLine) vals.push(p.refLine.value);
    lo = vals.length ? Math.min(...vals) : 0;
    hi = vals.length ? Math.max(...vals) : 1;
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;
  }
  const y = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * plotH;
  const refY = p.refLine ? y(p.refLine.value) : null;
  const ticks = (p.ticks ?? niceTicks(lo, hi)).filter((v) => refY === null || Math.abs(y(v) - refY) > 10);

  // Notifications closer together than a marker is wide (hourly ones, back to back) draw as one pill;
  // each still has its own target, and the picked one shows as a dot on top.
  const groups: number[][] = [];
  for (const i of p.markers ?? []) {
    const g = groups[groups.length - 1];
    if (g && X.x(i) - X.x(g[g.length - 1]) < 2 * R + 2) g.push(i);
    else groups.push([i]);
  }
  const grouped = new Set(groups.filter((g) => g.length > 1).flat());

  const line = linePath(values, X, y);
  const half = X.step / 2;
  const at = idx !== null ? values[idx] : null;

  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    p.onHover(X.invert(e.clientX - r.left));
  };

  return (
    <figure className="panel">
      <figcaption className="panel-head">
        <span className="panel-title">{p.title}</span>
        {p.value !== undefined && <span className="panel-value">{p.value}</span>}
      </figcaption>
      <svg className="plot" width={X.width} height={svgH} role="img" aria-label={p.label}>
        <g className="tick">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={X.width - M.right} y1={y(v)} y2={y(v)} />
              <text x={M.left - 6} y={y(v) + 3.5} textAnchor="end">{yFmt(v)}</text>
            </g>
          ))}
        </g>
        {p.dividers?.map((i) => <line key={i} className="divider" x1={X.x(i) - half} x2={X.x(i) - half} y1={top} y2={bottom} />)}
        {p.shade && spans(p.shade).map(([a, b]) => (
          <rect key={a} className={`shade ${tone}`} x={Math.max(M.left, X.x(a) - half)} y={top}
            width={Math.min(X.width - M.right, X.x(b) + half) - Math.max(M.left, X.x(a) - half)} height={plotH} />
        ))}
        {p.band && <path className="band" d={bandPath(p.band[0], p.band[1], X, y)} />}
        {p.refLine && refY !== null && (
          <>
            <line className={`ref ${p.refLine.tone}`} x1={M.left} x2={X.width - M.right} y1={refY} y2={refY} />
            <text className="ref-tick" x={M.left - 6} y={refY + 3.5} textAnchor="end">{yFmt(p.refLine.value)}</text>
          </>
        )}
        <path className="series" d={line} style={{ stroke: p.color ?? "var(--line)" }} />
        {idx !== null && <line className="cross" x1={X.x(idx)} x2={X.x(idx)} y1={top} y2={bottom} />}
        {idx !== null && at !== null && at !== undefined && (
          <circle className="now" cx={X.x(idx)} cy={y(at)} r={4} style={{ fill: p.color ?? "var(--line)" }} />
        )}
        {p.axis && (
          <g className="axis">
            {p.axis.map((t) => (
              <text key={t.i} x={X.x(t.i)} y={bottom + 15} textAnchor="middle" className={t.mark ? "day-mark" : undefined}>
                {t.title && <title>{t.title}</title>}
                {t.label}{t.mark ? " •" : ""}
              </text>
            ))}
          </g>
        )}
        <rect x={M.left} y={0} width={X.width - M.left - M.right} height={bottom} fill="transparent" style={{ cursor: "crosshair" }}
          onPointerMove={move} onPointerDown={move} onPointerLeave={() => p.onHover(null)}
          onClick={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); p.onPick(X.invert(e.clientX - r.left)); }} />
        {groups.filter((g) => g.length > 1).map((g) => (
          <rect key={`run${g[0]}`} className={`m-run ${tone}`} x={X.x(g[0]) - R} y={MARK / 2 - R}
            width={X.x(g[g.length - 1]) - X.x(g[0]) + 2 * R} height={2 * R} rx={R} />
        ))}
        {p.markers?.map((i) => (
          <g key={i} className={`marker ${tone}${i === p.pinned ? " on" : ""}${grouped.has(i) ? " grouped" : ""}`} onClick={() => p.onPick(i)}
            onPointerEnter={() => p.onHover(i)} tabIndex={0} onFocus={() => p.onHover(i)} onBlur={() => p.onHover(null)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onPick(i); } }}
            role="button" aria-label={p.markerLabel ? p.markerLabel(i) : "Alert"}>
            <circle className="hit" cx={X.x(i)} cy={MARK / 2} r={grouped.has(i) ? Math.max(2, X.step / 2) : 12} />
            <circle className="m" cx={X.x(i)} cy={MARK / 2} r={R} />
          </g>
        ))}
      </svg>
    </figure>
  );
}
