import { Crosshair, HitLayer, MARGIN, XAxis, type XScale } from "./chart";
import { cutoffs, refValue, type Node } from "./rule";
import type { Demo } from "./types";

function spans(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if (!f && start >= 0) { out.push([start, i - 1]); start = -1; }
  });
  if (start >= 0) out.push([start, flags.length - 1]);
  return out;
}

const STEP = (X: XScale) => (X.width - MARGIN.left - MARGIN.right) / 288;

function Band({ flags, X, y, h, cls }: { flags: boolean[]; X: XScale; y: number; h: number; cls: string }) {
  const w = STEP(X);
  return (
    <>
      {spans(flags).map(([a, b]) => (
        <rect key={a} className={cls} x={X.x(a)} y={y} width={Math.max(2, X.x(b) - X.x(a) + w)} height={h} rx={2} />
      ))}
    </>
  );
}

function Fires({ idxs, X, y, cls, onIdx }: { idxs: number[]; X: XScale; y: number; cls: string; onIdx: (i: number) => void }) {
  return (
    <>
      {idxs.map((i) => (
        <g key={i} className="fire" onClick={() => onIdx(i)} onPointerEnter={() => onIdx(i)}>
          <circle cx={X.x(i)} cy={y} r={12} fill="transparent" />
          <circle cx={X.x(i)} cy={y} r={5} className={cls} />
        </g>
      ))}
    </>
  );
}

export interface ProbLine {
  label: string;
  color: string;
  values: number[];
  cutoff: number[];
}

/** Lines for every probability the rule compares to a number (at most two, in rule order). */
export function ruleLines(d: Demo, tree: Node): ProbLine[] {
  const lines: ProbLine[] = [];
  const qs = d.alert.questions;
  const colors = ["var(--s1)", "var(--s3)"];
  const add = (qid: string, option: string | null, label: string) => {
    const c = cutoffs(tree, qid, option);
    if (!c.length || lines.length >= 2) return;
    const q = qs.find((x) => x.id === qid)!;
    lines.push({ label, color: colors[lines.length], cutoff: c,
      values: d.decisions.map((a) => Number(refValue(a[qid], q, option))) });
  };
  const walk = (n: Node) => {
    if (n.k === "cmp") {
      const q = qs.find((x) => x.id === n.qid)!;
      if (typeof n.value === "number" && (q.kind === "probability" || n.option))
        add(n.qid, n.option, n.option ? `P(${n.qid} = ${n.option})` : `P(${n.qid})`);
    } else if (n.k === "not") walk(n.a);
    else { walk(n.a); walk(n.b); }
  };
  walk(tree);
  return lines;
}

export function Lanes({ d, X, idx, onIdx, ruleTrue, semFired, thrFired, lines }: {
  d: Demo; X: XScale; idx: number; onIdx: (i: number) => void;
  ruleTrue: boolean[]; semFired: number[]; thrFired: number[]; lines: ProbLine[];
}) {
  const thrH = 46;
  const semTop = 8;
  const semPlot = 96;
  const strip = 14;
  const semH = semTop + semPlot + 10 + strip + 22;
  const py = (p: number) => semTop + semPlot - p * semPlot;
  const lineD = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${X.x(i).toFixed(1)},${py(v).toFixed(1)}`).join("");
  const stripY = semTop + semPlot + 10;
  const allCuts = [...new Set(lines.flatMap((l) => l.cutoff))];
  return (
    <div className="lanes">
      <figure className="panel lane">
        <figcaption>
          <span className="panel-title">
            <span className="mark thr" /> Threshold alert <code>{d.alert.baseline_label}</code>
          </span>
          <span className="lane-count"><b>{thrFired.length}</b> firings</span>
        </figcaption>
        <svg width={X.width} height={thrH} role="img" aria-label={`Threshold alert fired ${thrFired.length} times`}>
          <line className="lane-base" x1={MARGIN.left} x2={X.width - MARGIN.right} y1={18} y2={18} />
          <Band flags={d.threshold_true} X={X} y={12} h={12} cls="band thr" />
          <Crosshair X={X} idx={idx} top={2} bottom={thrH - 2} />
          <HitLayer X={X} height={thrH} onIdx={onIdx} />
          <Fires idxs={thrFired} X={X} y={18} cls="fire-dot thr" onIdx={onIdx} />
        </svg>
      </figure>
      <figure className="panel lane">
        <figcaption>
          <span className="panel-title">
            <span className="mark sem" /> Semantic alert <code>{d.alert.rule}</code>
          </span>
          <span className="lane-count"><b>{semFired.length}</b> firings</span>
        </figcaption>
        <div className="legend">
          {lines.map((l) => (
            <span key={l.label} className="key">
              <span className="swatch" style={{ background: l.color }} />
              <span className="key-label mono">{l.label}</span>
              <span className="key-value">{l.values[idx].toFixed(2)}</span>
            </span>
          ))}
          <span className="key"><span className="swatch band-swatch" /><span className="key-label">rule true</span>
            <span className="key-value">{ruleTrue[idx] ? "yes" : "no"}</span></span>
        </div>
        <svg width={X.width} height={semH} role="img" aria-label={`Semantic alert fired ${semFired.length} times`}>
          <g className="grid">
            {[0, 0.5, 1].map((p) => (
              <g key={p}>
                <line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={py(p)} y2={py(p)} />
                <text x={MARGIN.left - 6} y={py(p) + 3.5} textAnchor="end">{p.toFixed(1)}</text>
              </g>
            ))}
          </g>
          {allCuts.map((c) => (
            <g key={c} className="cutoff">
              <line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={py(c)} y2={py(c)} />
            </g>
          ))}
          {allCuts.length > 0 && (
            <text className="cutoff-label" x={X.width - MARGIN.right} y={py(Math.max(...allCuts)) - 4} textAnchor="end">
              cutoff{allCuts.length > 1 ? "s" : ""} {[...allCuts].sort().join(" / ")}
            </text>
          )}
          {lines.map((l) => <path key={l.label} d={lineD(l.values)} className="series" style={{ stroke: l.color }} />)}
          <line className="lane-base" x1={MARGIN.left} x2={X.width - MARGIN.right} y1={stripY + strip / 2} y2={stripY + strip / 2} />
          <Band flags={ruleTrue} X={X} y={stripY} h={strip} cls="band sem" />
          <Crosshair X={X} idx={idx} top={semTop} bottom={stripY + strip} />
          {lines.map((l) => <circle key={l.label} cx={X.x(idx)} cy={py(l.values[idx])} r={4} className="dot" style={{ fill: l.color }} />)}
          <XAxis t={d.t} X={X} top={stripY + strip} />
          <HitLayer X={X} height={semH} onIdx={onIdx} />
          <Fires idxs={semFired} X={X} y={stripY + strip / 2} cls="fire-dot sem" onIdx={onIdx} />
        </svg>
      </figure>
    </div>
  );
}

/** Phase 7: the real run's primary probability vs. the simulated run's, on one 0-1 axis. */
export function WhatIf({ real, sim, X, idx, onIdx }: { real: Demo; sim: Demo & { simulated: { label: string; method: string } }; X: XScale; idx: number; onIdx: (i: number) => void }) {
  const p = real.alert.primary;
  const rv = real.decisions.map((a) => a[p].probs.yes);
  const sv = sim.decisions.map((a) => a[p].probs.yes);
  const top = 8, plot = 90, strip = 10;
  const h = top + plot + 10 + strip * 2 + 6 + 22;
  const py = (v: number) => top + plot - v * plot;
  const d = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${X.x(i).toFixed(1)},${py(v).toFixed(1)}`).join("");
  const s1 = top + plot + 10, s2 = s1 + strip + 6;
  const cuts = [...new Set(cutoffsFor(real))];
  return (
    <figure className="panel lane whatif">
      <figcaption>
        <span className="panel-title">{sim.simulated.label}</span>
        <span className="lane-count"><b>{sim.fired.semantic.length}</b> simulated vs <b>{real.fired.semantic.length}</b> real firings</span>
      </figcaption>
      <p className="muted small whatif-note">{sim.simulated.method}</p>
      <div className="legend">
        <span className="key"><span className="swatch" style={{ background: "var(--muted-series)" }} /><span className="key-label">Real: P({p})</span><span className="key-value">{rv[idx].toFixed(2)}</span></span>
        <span className="key"><span className="swatch" style={{ background: "var(--s3)" }} /><span className="key-label">Simulated: P({p})</span><span className="key-value">{sv[idx].toFixed(2)}</span></span>
      </div>
      <svg width={X.width} height={h} role="img" aria-label="Real versus simulated scarcity probability">
        <g className="grid">
          {[0, 0.5, 1].map((v) => (
            <g key={v}><line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={py(v)} y2={py(v)} />
              <text x={MARGIN.left - 6} y={py(v) + 3.5} textAnchor="end">{v.toFixed(1)}</text></g>
          ))}
          <text x={MARGIN.left - 6} y={s1 + 8} textAnchor="end">real</text>
          <text x={MARGIN.left - 6} y={s2 + 8} textAnchor="end">sim</text>
        </g>
        {cuts.map((c) => <g key={c} className="cutoff"><line x1={MARGIN.left} x2={X.width - MARGIN.right} y1={py(c)} y2={py(c)} /></g>)}
        <path d={d(rv)} className="series" style={{ stroke: "var(--muted-series)" }} />
        <path d={d(sv)} className="series" style={{ stroke: "var(--s3)" }} />
        <Band flags={real.rule_true} X={X} y={s1} h={strip} cls="band sem" />
        <Band flags={sim.rule_true} X={X} y={s2} h={strip} cls="band sim" />
        <Crosshair X={X} idx={idx} top={top} bottom={s2 + strip} />
        <XAxis t={real.t} X={X} top={s2 + strip + 6} />
        <HitLayer X={X} height={h} onIdx={onIdx} />
        <Fires idxs={real.fired.semantic} X={X} y={s1 + strip / 2} cls="fire-dot sem" onIdx={onIdx} />
        <Fires idxs={sim.fired.semantic} X={X} y={s2 + strip / 2} cls="fire-dot sim" onIdx={onIdx} />
      </svg>
    </figure>
  );
}

function cutoffsFor(d: Demo): number[] {
  const m = d.alert.rule.match(new RegExp(`\\b${d.alert.primary}\\s*>=?\\s*([0-9.]+)`));
  return m ? [Number(m[1])] : [];
}
