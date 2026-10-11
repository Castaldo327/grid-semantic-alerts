import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Panel, makeX, spans, useWidth, type Tick, type XScale } from "./chart";
import { cutoffs, evaluate, parse } from "./rule";
import { AlertCol, Answers, BASE, Mail, Quiet, Section, Shell, gw, orNA, pct, usd } from "./site";
import { dayLabel, hourLabel, weekLabel, weekOf, type Hourly, type SuggestedWeek, type Week } from "./explore/data";
import { FEATURED_WEEK, RULES } from "./explore/featured";
import type { WeekRun } from "./explore/run";
import { checkedValues, holds, notifications, seriesOf, type Threshold } from "./explore/series";

const deg = (f: number) => `${Math.round(f)}°F`;
const mwh = (x: number) => `${usd(x)}/MWh`;
const shortDay = (date: string) => `${dayLabel(date, { weekday: "short" })} ${Number(date.slice(8))}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const fmt = (t: Threshold, v: number | null) => {
  const u = seriesOf(t).unit;
  return orNA(v, (x) => (u === "°F" ? deg(x) : u === "$/MWh" ? mwh(x) : `${Math.round(x).toLocaleString("en-US")} MW`));
};

interface Rule { part: string; line: string; t: Threshold; values: (number | null)[]; flags: boolean[] }
interface Moment { k: number; title: string; body: string }

/** The day that hour k of the week falls on. */
const dayAt = (w: Week, k: number) => w.days.find((x) => w.from + k < x.first_hour + x.hours) ?? w.days[w.days.length - 1];

/** Alerts that watch reserves (the reserves line itself, or the price of reserves). */
const watchesReserves = (r: Rule) => r.t.series === "prc" || r.t.series === "nspin";

/** Three hours that show the difference, found in the data: the priciest hour the sentence let pass, its
 *  first notification, and the week's lowest reserves. */
function moments(d: Hourly, w: Week, rules: Rule[], P: (number | null)[], ruleTrue: boolean[], first: number | undefined): Moment[] {
  const s = d.series;
  const at = (k: number) => w.from + k;
  const on = (k: number) => rules.filter((r) => r.flags[k]);
  const hours = P.map((_, k) => k);
  const by = (ks: number[], score: (k: number) => number) => ks.reduce((best, k) => (score(k) > score(best) ? k : best), ks[0]);
  const a = by(hours.filter((k) => !ruleTrue[k]), (k) => s.hub_max[at(k)] ?? -Infinity);
  const c = by(hours, (k) => -(s.prc_min[at(k)] ?? Infinity));
  const reserveAlerts = (k: number) => on(k).filter(watchesReserves);
  const out: Moment[] = [];
  if (a !== undefined) out.push({ k: a, title: "Expensive, not short",
    body: `The hub price reaches ${orNA(s.hub_max[at(a)], mwh)}, and ${list(on(a).map((r) => r.line))} ${on(a).length === 1 ? "notifies" : "notify"} you. Reserves are ${orNA(s.prc[at(a)], gw)}, so the model rates the hour ${pct(P[a] ?? 0)} and the sentence stays quiet.` });
  if (first !== undefined && first !== c) out.push({ k: first, title: reserveAlerts(first).length ? "The sentence notifies" : "Ahead of the thresholds",
    body: `Reserves fall from ${orNA(s.prc[at(first) - 1], gw)} to a low of ${orNA(s.prc_min[at(first)], gw)} within the hour, and the price reaches ${orNA(s.hub_max[at(first)], mwh)}. ${reserveAlerts(first).length ? `${list(reserveAlerts(first).map((r) => r.line))} fires too.` : "Neither reserves alert has fired."} The model rates it ${pct(P[first] ?? 0)} and the sentence notifies you.` });
  if (c !== undefined) {
    const never = rules.filter((r) => watchesReserves(r) && !r.flags.some(Boolean));
    out.push({ k: c, title: "The shortage",
      body: `Reserves bottom out at ${orNA(s.prc_min[at(c)], gw)}, the price hits ${orNA(s.hub_max[at(c)], mwh)} and non-spin ${orNA(s.nspin_max[at(c)], mwh)}. ${reserveAlerts(c).length ? `${list(reserveAlerts(c).map((r) => r.line))} fires now` : "No reserves alert fires"}${never.length ? `; ${list(never.map((r) => r.line))} never does` : ""}. The model rates it ${pct(P[c] ?? 0)}.` });
  }
  return out.sort((x, y) => x.k - y.k);
}

/** The threshold alerts as rows of true and false over the week, on the same axis as the curve below. */
function Strips({ X, rules, any, idx, onHover, onPick, dividers }: {
  X: XScale; rules: Rule[]; any: boolean[]; idx: number;
  onHover: (k: number | null) => void; onPick: (k: number) => void; dividers: number[];
}) {
  const H = 11, G = 5;
  const rows = [...rules.map((r) => ({ label: r.line, flags: r.flags, any: false })), { label: `Any of the ${rules.length}`, flags: any, any: true }];
  const yOf = (j: number) => j * (H + G) + (j === rows.length - 1 ? 6 : 0);
  const height = yOf(rows.length - 1) + H + 2;
  const half = X.step / 2;
  const at = (e: React.MouseEvent<SVGRectElement>) => X.invert(e.clientX - (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect().left);
  return (
    <svg className="strips" width={X.width} height={height} role="img"
      aria-label={`The threshold alerts, hour by hour: ${rules.map((r) => `${r.line}, true in ${r.flags.filter(Boolean).length} hours`).join("; ")}.`}>
      {dividers.map((i) => <line key={i} className="divider" x1={X.x(i) - half} x2={X.x(i) - half} y1={0} y2={height} />)}
      {rows.map((r, j) => (
        <g key={r.label} className={r.any ? "strip any" : "strip"}>
          <text className="strip-label" x={X.left - 8} y={yOf(j) + H - 1.5} textAnchor="end">{r.label}</text>
          <rect className="strip-bg" x={X.left} y={yOf(j)} width={X.width - X.left - X.right} height={H} rx={2} />
          {spans(r.flags).map(([a, b]) => (
            <rect key={a} className="strip-on" x={Math.max(X.left, X.x(a) - half)} y={yOf(j)}
              width={Math.min(X.width - X.right, X.x(b) + half) - Math.max(X.left, X.x(a) - half)} height={H} rx={2} />
          ))}
          <text className="strip-n" x={X.width - X.right + 6} y={yOf(j) + H - 1.5}>{r.flags.filter(Boolean).length}h</text>
        </g>
      ))}
      <line className="cross" x1={X.x(idx)} x2={X.x(idx)} y1={0} y2={height} />
      <rect x={X.left} y={0} width={X.width - X.left - X.right} height={height} fill="transparent" style={{ cursor: "crosshair" }}
        onPointerMove={(e) => onHover(at(e))} onPointerDown={(e) => onHover(at(e))} onPointerLeave={() => onHover(null)} onClick={(e) => onPick(at(e))} />
    </svg>
  );
}

/** A heading over one side's chart: which alerts, how their logic works, and how many notifications they sent. */
function Side({ tone, title, n, children }: { tone: "thr" | "sem"; title: ReactNode; n: number; children: ReactNode }) {
  return (
    <div className="side">
      <div>
        <h3 className="side-title"><span className={`key-dot ${tone}`} />{title}</h3>
        <p>{children}</p>
      </div>
      <div className="side-n"><b>{n}</b>notification{n === 1 ? "" : "s"}</div>
    </div>
  );
}

function Story({ d, run, ex }: { d: Hourly; run: WeekRun; ex: SuggestedWeek }) {
  const week = useMemo(() => weekOf(d, run.week), [d, run.week]);
  const n = week.to - week.from;
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width < 560;
  const X = useMemo(() => makeX(n, width, narrow ? 108 : 124, narrow ? 30 : 34), [n, width, narrow]);
  const tree = useMemo(() => parse(run.compiled.rule, run.compiled.questions), [run]);
  const primary = run.compiled.primary;
  const primaryQ = run.compiled.questions.find((q) => q.id === primary)!;
  const P = useMemo(() => run.answers.map((a) => (a && !a[primary].refused ? a[primary].probs.yes : null)), [run, primary]);
  const cut = cutoffs(tree, primary)[0];
  const s = d.series;
  const at = (k: number) => week.from + k;

  // Both sides are recomputed here: the sentence from the model's saved answers (and checked against the
  // saved run), the threshold alerts from the data, each hour checked the way the alert form would.
  const ruleTrue = useMemo(() => run.answers.map((a) => !!a && evaluate(tree, a, run.compiled.questions)), [run, tree]);
  const parity = JSON.stringify(ruleTrue) === JSON.stringify(run.rule_true);
  const semNotes = useMemo(() => notifications(ruleTrue, null), [ruleTrue]);
  const rules = useMemo<Rule[]>(() => RULES.map(({ part, line, ...t }) => {
    const values = checkedValues(d, t, week.from, week.to);
    return { part, line, t, values, flags: values.map((v) => holds(t, v)) };
  }), [d, week]);
  const any = useMemo(() => rules[0].flags.map((_, k) => rules.some((r) => r.flags[k])), [rules]);
  const thrNotes = rules.reduce((sum, r) => sum + notifications(r.flags, null).length, 0);

  // How close the reserves line came to mattering: the week's lowest reserves, and what half a gigawatt
  // more would have caught.
  const reserveLine = rules.find((r) => r.t.series === "prc");
  const lowest = Math.min(...s.prc_min.slice(week.from, week.to).filter((v): v is number => v !== null));
  const nearMiss = reserveLine ? reserveLine.values.filter((v) => v !== null && v < reserveLine.t.value + 500).length : 0;
  const first = semNotes[0];
  const firstReserve = rules.filter(watchesReserves).map((r) => r.flags.indexOf(true)).filter((k) => k >= 0).sort((x, y) => x - y)[0];
  const ahead = first !== undefined && firstReserve !== undefined ? firstReserve - first : 0;
  const sorted = P.filter((p): p is number => p !== null).sort((x, y) => x - y);
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;

  const steps = useMemo(() => moments(d, week, rules, P, ruleTrue, first), [d, week, rules, P, ruleTrue, first]);
  const skipped = steps.find((m) => m.title === "Expensive, not short");
  const [pinned, setPinned] = useState(() => steps[0]?.k ?? 0);
  const [hover, setHover] = useState<number | null>(null);
  const k = hover ?? pinned;
  const pin = (x: number) => { setPinned(Math.max(0, Math.min(n - 1, x))); setHover(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      pin(pinned + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 24 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const i = at(k);
  const day = dayAt(week, k);
  const when = (m: number) => `${shortDay(dayAt(week, m).date)}, ${hourLabel(d, at(m))}`;
  const moment = steps.findIndex((m) => m.k === k);
  const dividers = week.days.slice(1).map((x) => x.first_hour - week.from);
  const axis: Tick[] = week.days.map((x) => ({ i: x.first_hour - week.from + Math.floor(x.hours / 2), label: narrow ? String(Number(x.date.slice(8))) : shortDay(x.date) }));
  const trueNow = rules.filter((r) => r.flags[k]);
  const notedDays = [...new Set(semNotes.map((m) => dayAt(week, m).date))];
  const notedHours = semNotes.map((m) => hourLabel(d, at(m)));

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">A feature concept for Grid Status alerts</p>
        <h1>Alerts for situations, not just numbers</h1>
        <p className="lede">
          Grid Status alerts are Boolean: one series against one line. Customers think in situations. Here is one, written as a
          single alert and run on a real winter freeze, next to the threshold alerts it would take today.
        </p>
      </header>

      <div className="card">
        <Section title={`Winter freeze: ${weekLabel(week)}`} help={ex.note}>
          <figure className="featured">
            <blockquote className="input locked tall"><span className="key-dot sem" />{ex.example}</blockquote>
            <figcaption>What a demand-response aggregator would write: it cuts customers' load only in a real shortage, and a
              price spike alone isn't one.</figcaption>
          </figure>

          <div className="logic" ref={ref}>
            <Side tone="thr" title={`Today: ${plural(RULES.length, "threshold alert")}, one per part of the sentence`} n={thrNotes}>
              <b>Classical (Boolean) logic.</b> {list([...new Set(RULES.map((r) => `“${r.part}”`))])} each become a series and a
              line. The form can't combine them or say “not just”, so each fires on its own: {any.filter(Boolean).length} of {n} hours
              flagged.{reserveLine && !reserveLine.flags.some(Boolean)
                ? ` Reserves never fell below ${gw(lowest)}, so the reserves alert at its usual line never fires${nearMiss ? `; half a gigawatt higher, it catches ${plural(nearMiss, "hour")}` : ""}.`
                : ""}
            </Side>
            <Strips X={X} rules={rules} any={any} idx={k} onHover={setHover} onPick={pin} dividers={dividers} />
            <Side tone="sem" title={<>Proposed: 1 sentence<span className="badge">New</span></>} n={semNotes.length}>
              <b>Fuzzy logic.</b> “Short of reserves” has no line: it depends on how fast reserves are falling, how cold it is and
              what prices are doing. The model gives every hour a degree of truth from all of it at once, and only the decision to
              notify is a cutoff.
            </Side>
            <Panel X={X} idx={k} pinned={pinned} onHover={setHover} onPick={pin} dividers={dividers} axis={axis} height={96}
              label={`The model's degree of truth for each hour, with its cutoff and the sentence alert's ${plural(semNotes.length, "notification")}`}
              title={<>Degree of truth <span className="muted">· “{primaryQ.text}” · notifies at {pct(cut ?? 0.7)}</span></>} value={orNA(P[k], pct)}
              values={P} domain={[0, 1]} ticks={[0, 0.5, 1]} yFmt={pct} color="var(--sem)" shade={ruleTrue} tone="sem"
              markers={semNotes} markerLabel={(m) => `Notification, ${when(m)}`} refLine={cut !== undefined ? { value: cut, tone: "sem" } : undefined} />
            <p className="logic-foot">
              Most hours sit near {pct(typical)}.{skipped && ` The ${orNA(s.hub_max[at(skipped.k)], mwh)} hour, with ${orNA(s.prc[at(skipped.k)], gw)} of reserves, scored ${orNA(P[skipped.k], pct)}.`}
              {semNotes.length > 0 && <> It notified {plural(semNotes.length, "time")}, on {list(notedDays.map(shortDay))} at {list(notedHours)}{ahead > 0 ? `, ${plural(ahead, "hour")} before any reserves alert` : ""}.</>}
            </p>
          </div>

          <div className="moments" role="group" aria-label="Where they differ">
            {steps.map((m, j) => (
              <button key={m.k} type="button" className="moment" aria-pressed={j === moment} onClick={() => pin(m.k)}>
                <b>{when(m.k)}</b>{m.title}
              </button>
            ))}
          </div>

          <div className="inspect" aria-live="polite">
            <div className="inspect-head">
              <h3 className="inspect-time">{dayLabel(day.date)} <span>{hourLabel(d, i)}{moment >= 0 ? ` · ${steps[moment].title}` : ""}</span></h3>
              <div className="facts">
                <span>Reserves <b>{orNA(s.prc[i], gw)}</b></span>
                <span>Hub price <b>{orNA(s.hub[i], mwh)}</b></span>
                <span>Non-spin <b>{orNA(s.nspin[i], mwh)}</b></span>
                <span>Demand <b>{orNA(s.load[i], gw)}</b></span>
                <span>Dallas <b>{orNA(s.temp_dfw[i], deg)}</b></span>
              </div>
            </div>
            {moment >= 0 && <p className="narrative">{steps[moment].body}</p>}
            <div className="cols">
              <AlertCol tone="thr" label={plural(RULES.length, "threshold alert")}>
                {trueNow.length
                  ? <p className="quiet hit">{trueNow.length} of {RULES.length} true: {plural(trueNow.length, "notification")}, one from each.</p>
                  : <Quiet>None true: no notification.</Quiet>}
                <ul className="checks">
                  {rules.map((r) => (
                    <li key={r.line} className={r.flags[k] ? "met" : ""}>
                      <span>{r.flags[k] ? "✓" : "✗"} {r.line}</span><span className="val">{fmt(r.t, r.values[k])}</span>
                    </li>
                  ))}
                </ul>
              </AlertCol>
              <AlertCol tone="sem" label="1 sentence">
                {semNotes.includes(k)
                  ? <Mail tone="sem" name={ex.name} when={`${when(k)} CT`}>
                      {primaryQ.text} Yes, {orNA(P[k], pct)}. Reserves {orNA(s.prc[i], gw)} (low {orNA(s.prc_min[i], gw)}), hub {orNA(s.hub[i], mwh)} (high {orNA(s.hub_max[i], mwh)}), non-spin up to {orNA(s.nspin_max[i], mwh)}, {orNA(s.temp[i], deg)}.
                    </Mail>
                  : <Quiet>No notification.</Quiet>}
                <Answers questions={run.compiled.questions} answers={run.answers[k]} tree={tree} />
                <details className="read">
                  <summary>What the model read</summary>
                  <p>{run.prose[k]}</p>
                </details>
              </AlertCol>
            </div>
          </div>
        </Section>
      </div>

      <div className="card">
        <Section title="How it works" help="A general-purpose classifier turns fuzzy, real-time grid conditions into a number an alert can act on. The model grades; code decides.">
          <div className="how">
            <div>
              <span className="n">1</span>
              <h3>Compile the sentence once</h3>
              <p>When the alert is saved, gpt-6-luna turns it into questions and a rule, checked by a validator before it's accepted. A sentence with “not just” must get a rule that rules that case out.</p>
              <ul>{run.compiled.questions.map((q) => <li key={q.id}>{q.text} <span className="muted">({q.kind === "probability" ? "yes / no" : q.options.join(" · ")})</span></li>)}</ul>
            </div>
            <div>
              <span className="n">2</span>
              <h3>Grade every new row</h3>
              <p>Each hour becomes a short snapshot of the grid, using only what was known then. OpenAI's Decisions API answers with probabilities, not text.</p>
              {run.stats && (
                <div className="stats">
                  <div><b>{run.stats.latency_ms.median} ms</b><span>median per hour</span></div>
                  <div><b>${run.stats.cost_usd.toFixed(3)}</b><span>for all {run.stats.calls} hours of the week</span></div>
                </div>
              )}
            </div>
            <div>
              <span className="n">3</span>
              <h3>Decide in plain code</h3>
              <p>The rule and the Notification Timeout decide, with no model involved, so every notification can be tested and explained.</p>
              <code className="rule">{run.compiled.rule}</code>
              <p className={`small ${parity ? "ok" : "bad"}`} style={{ marginTop: 8 }}>
                {parity ? "✓ This page recomputed every notification from the model's answers. They match the saved run." : "✗ The recomputed notifications don't match the saved run."}
              </p>
            </div>
          </div>
        </Section>
      </div>

      <div className="card">
        <Section title="Why I built this">
          <ul className="why-list">
            <li><b>A gap worth closing.</b> Customers think in situations, like “short of reserves, not just expensive”, and today's alerts can't express one. This adds one option to the existing alert form, next to Threshold.</li>
            <li><b>Built end to end on Grid Status data.</b> API pulls, the prompts and validator that compile a sentence, a static React app, and saved runs anyone can replay without a key.</li>
            <li><b>Cheap, fast and checkable.</b> About a cent per week of hourly checks, decisions in plain code, and a page that verifies its own numbers.</li>
          </ul>
        </Section>
      </div>

      <div className="card cta">
        <p>Try this sentence on another week, or write your own, in the alert form.</p>
        <a className="btn" href={`${BASE}try/`}>Create an alert</a>
      </div>
    </>
  );
}

export default function App() {
  const [data, setData] = useState<{ d: Hourly; run: WeekRun; ex: SuggestedWeek } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${BASE}explore/ercot_hourly.json`).then((r) => r.json()),
      fetch(`${BASE}explore/runs/${FEATURED_WEEK}.json`).then((r) => r.json()),
    ]).then(([d, run]: [Hourly, WeekRun]) => {
      const ex = d.weeks.find((w) => w.start === FEATURED_WEEK);
      if (!ex || ex.example !== run.sentence) throw new Error(`no saved run of the ${FEATURED_WEEK} example`);
      setData({ d, run, ex });
    }).catch((e) => setErr(String(e)));
  }, []);

  return (
    <Shell page="overview" footer={
      <>
        <p>Hourly data from the Grid Status API{data ? ` (${data.d.datasets.join(", ")})` : ""}. Times are US Central.</p>
        <p>Model: OpenAI gpt-6-luna, through the Responses API to compile the sentence and the Decisions API to grade each hour. This page replays a saved run and makes no API calls.</p>
      </>
    }>
      {err && <p className="bad page-head">Couldn't load the data: {err}</p>}
      {!data && !err && <p className="muted page-head">Loading…</p>}
      {data && <Story d={data.d} run={data.run} ex={data.ex} />}
    </Shell>
  );
}
