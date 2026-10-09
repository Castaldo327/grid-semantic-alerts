// The two charts that tell each scenario's story, on one shared time axis:
//   ThresholdChart: the series today's threshold alert watches, its threshold line, and its firings.
//   ProbChart:      the sentence alert's main probability, its cutoff, and its firings.

import { Crosshair, HitLayer, MARGIN, XAxis, type XScale } from "./chart";

const TOP = 26; // room for firing markers above the plot

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

function Markers({ idxs, X, cls, idx, onPick }: { idxs: number[]; X: XScale; cls: string; idx: number; onPick: (i: number) => void }) {
  return (
    <g>
      {idxs.map((i) => (
        <g key={i} className={`marker ${cls}${i === idx ? " active" : ""}`} onClick={() => onPick(i)} role="button" aria-label="Jump to this alert">
          <line x1={X.x(i)} x2={X.x(i)} y1={12} y2={TOP} />
          <circle cx={X.x(i)} cy={10} r={14} className="hit" />
          <circle cx={X.x(i)} cy={10} r={6} />
        </g>
      ))}
    </g>
  );
}

function linePath(vals: (number | null)[], X: XScale, y: (v: number) => number) {
  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${X.x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export interface StorySeries { label: string; values: (number | null)[]; cls: string; fmt: (v: number) => string }

export function ThresholdChart({ X, t, idx, onIdx, onPick, series, log, threshold, thresholdLabel, fired, active, yTick, height = 230 }: {
  X: XScale; t: string[]; idx: number; onIdx: (i: number) => void; onPick: (i: number) => void;
  series: StorySeries[]; log?: boolean; threshold: number; thresholdLabel: string;
  fired: number[]; active: boolean[]; yTick: (v: number) => string; height?: number;
}) {
  const plotH = height - TOP - 26;
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null)).concat(threshold);
  let y: (v: number) => number;
  let ticks: number[];
  if (log) {
    const lo = Math.floor(Math.log10(Math.max(1, Math.min(...vals))));
    const hi = Math.ceil(Math.log10(Math.max(...vals)));
    ticks = Array.from({ length: hi - lo + 1 }, (_, k) => 10 ** (lo + k));
    y = (v) => TOP + plotH - ((Math.log10(Math.max(10 ** lo, v)) - lo) / (hi - lo)) * plotH;
  } else {
    const max = Math.max(...vals) * 1.05;
    const min = Math.min(...vals) * 0.9;
    const step = (max - min) / 4;
    const mag = 10 ** Math.floor(Math.log10(step));
    const s = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= step)!;
    const lo = Math.floor(min / s) * s;
    const hi = Math.ceil(max / s) * s;
    ticks = [];
    for (let v = lo; v <= hi + s / 2; v += s) ticks.push(v);
    y = (v) => TOP + plotH - ((v - lo) / (hi - lo)) * plotH;
  }
  const w = (X.width - MARGIN.left - MARGIN.right) / X.n;
  return (
    <svg width={X.width} height={height} className="story" role="img" aria-label={thresholdLabel}>
      <g className="grid">
        {ticks.map((v) => (
          <g key={v}><line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={y(v)} y2={y(v)} />
            <text x={MARGIN.left - 8} y={y(v) + 4} textAnchor="end">{yTick(v)}</text></g>
        ))}
      </g>
      {spans(active).map(([a, b]) => (
        <rect key={a} className="zone thr" x={X.x(a)} y={TOP} width={X.x(b) - X.x(a) + w} height={plotH} />
      ))}
      <line className="limit thr" x1={MARGIN.left} x2={X.width - MARGIN.right} y1={y(threshold)} y2={y(threshold)} />
      <text className="limit-label thr" x={X.width - MARGIN.right - 4} y={y(threshold) - 7} textAnchor="end">{thresholdLabel}</text>
      {series.map((s) => <path key={s.label} d={linePath(s.values, X, y)} className={`line ${s.cls}`} />)}
      <Crosshair X={X} idx={idx} top={TOP} bottom={TOP + plotH} />
      {series.map((s) => s.values[idx] !== null && (
        <circle key={s.label} cx={X.x(idx)} cy={y(s.values[idx]!)} r={5} className={`now ${s.cls}`} />
      ))}
      <XAxis t={t} X={X} top={TOP + plotH + 4} />
      <HitLayer X={X} height={height} onIdx={onIdx} />
      <Markers idxs={fired} X={X} cls="thr" idx={idx} onPick={onPick} />
    </svg>
  );
}

export function ProbChart({ X, t, idx, onIdx, onPick, values, cutoff, ruleTrue, fired, height = 190 }: {
  X: XScale; t: string[]; idx: number; onIdx: (i: number) => void; onPick: (i: number) => void;
  values: number[]; cutoff: number | null; ruleTrue: boolean[]; fired: number[]; height?: number;
}) {
  const plotH = height - TOP - 26;
  const y = (p: number) => TOP + plotH - p * plotH;
  const line = values.map((v, i) => `${i ? "L" : "M"}${X.x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${X.x(values.length - 1)},${y(0)}L${X.x(0)},${y(0)}Z`;
  const w = (X.width - MARGIN.left - MARGIN.right) / X.n;
  return (
    <svg width={X.width} height={height} className="story" role="img" aria-label="Semantic alert probability">
      <g className="grid">
        {[0, 0.5, 1].map((p) => (
          <g key={p}><line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={y(p)} y2={y(p)} />
            <text x={MARGIN.left - 8} y={y(p) + 4} textAnchor="end">{Math.round(p * 100)}%</text></g>
        ))}
      </g>
      {spans(ruleTrue).map(([a, b]) => (
        <rect key={a} className="zone sem" x={X.x(a)} y={TOP} width={X.x(b) - X.x(a) + w} height={plotH} />
      ))}
      <path d={area} className="area sem" />
      <path d={line} className="line sem" />
      {cutoff !== null && <>
        <line className="limit sem" x1={MARGIN.left} x2={X.width - MARGIN.right} y1={y(cutoff)} y2={y(cutoff)} />
        <text className="limit-label sem" x={MARGIN.left + 6} y={y(cutoff) - 7}>alert needs {Math.round(cutoff * 100)}% or more</text>
      </>}
      <Crosshair X={X} idx={idx} top={TOP} bottom={TOP + plotH} />
      <circle cx={X.x(idx)} cy={y(values[idx])} r={5} className="now sem" />
      <XAxis t={t} X={X} top={TOP + plotH + 4} />
      <HitLayer X={X} height={height} onIdx={onIdx} />
      <Markers idxs={fired} X={X} cls="sem" idx={idx} onPick={onPick} />
    </svg>
  );
}
