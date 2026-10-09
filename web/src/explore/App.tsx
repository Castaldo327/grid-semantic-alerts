import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { M, Panel, makeX, useWidth, type XScale } from "../chart";
import { cutoffs, parse } from "../rule";
import { AlertCol, Answers, BASE, Callout, Field, Mail, MailIcon, NumberInput, Quiet, Section, Segmented, Select, Shell, ThresholdCheck, Toggle, gw, orNA, pct, usd } from "../site";
import { Calendar } from "./Calendar";
import type { Compiled } from "./compile";
import { addDays, dayLabel, hourLabel, lastStart, weekLabel, weekOf, type Day, type Hourly, type SeriesKey, type SuggestedWeek, type Week } from "./data";
import { USD_PER_M_INPUT, describe } from "./openai";
import { runWeek, type WeekRun } from "./run";
import { OPS, SERIES, checkedValues, holds, notifications, seriesOf, type SeriesOption, type Threshold } from "./series";
import { snapshot } from "./snapshot";

type Mode = "threshold" | "describe";
const TOKENS_PER_HOUR = 600; // measured: 515-540 input tokens per snapshot with two questions, 675 with three
const OP_LABEL = Object.fromEntries(OPS.map((o) => [o.op, o.label]));
const deg = (f: number) => `${Math.round(f)}°F`;
const gwTick = (v: number) => `${Math.round(v / 1000)}`;

// Short names for the unusual-day signals (pipeline/08_range_state.py), for the day headings over the
// charts, in the order a heading names them when a day had more than two.
const SIGNAL: Record<string, string> = {
  reserves: "Low reserves", price: "Price spike", reserve_price: "Non-spin spike", negative: "Negative price",
  demand: "High demand", wind: "Low wind", heat: "100°F heat", freeze: "Freeze",
};
const RANK = ["reserves", "negative", "price", "freeze", "heat", "wind", "reserve_price", "demand"];

// Grid data under the two alerts, for judging whether each notification was right. The threshold's own
// series is left out, since its chart is already there.
const CONTEXT: { id: string; name: string; note?: string; key: SeriesKey; band?: [SeriesKey, SeriesKey]; fmt: (v: number) => string; tick: (v: number) => string }[] = [
  { id: "prc", name: "Reserves (PRC), GW", note: "average and low", key: "prc", band: ["prc_min", "prc"], fmt: gw, tick: gwTick },
  { id: "hub", name: "Hub price, $/MWh", note: "average and range", key: "hub", band: ["hub_min", "hub_max"], fmt: (x) => `${usd(x)}/MWh`,
    tick: (v) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : `${v}`) },
  { id: "load", name: "Demand, GW", key: "load", fmt: gw, tick: gwTick },
  { id: "temp", name: "Temperature, °F", note: "weighted by where demand is", key: "temp", fmt: deg, tick: (v) => `${v}` },
  { id: "wind", name: "Wind, GW", key: "wind", fmt: gw, tick: gwTick },
];

const fmtValue = (s: SeriesOption, v: number) =>
  s.unit === "°F" ? deg(v) : s.unit === "$/MWh" ? `${usd(v)}/MWh` : `${Math.round(v).toLocaleString("en-US")} MW`;
const shortDay = (date: string) => `${dayLabel(date, { weekday: "short" })} ${Number(date.slice(8))}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The day that hour k of the week falls on. */
const dayAt = (w: Week, k: number) => w.days.find((x) => w.from + k < x.first_hour + x.hours) ?? w.days[w.days.length - 1];

/** "19 notifications on 6 days" */
const tally = (w: Week, notes: number[]) =>
  notes.length ? `${plural(notes.length, "notification")} on ${plural(new Set(notes.map((k) => dayAt(w, k).date)).size, "day")}` : "no notifications";

/** "6–10 PM" for notifications at the hours starting a..b, or "11 AM–1 PM". */
function hourRange(d: Hourly, a: number, b: number): string {
  if (a === b) return hourLabel(d, a);
  const [sh, sm] = hourLabel(d, a).split(" ");
  const [eh, em] = hourLabel(d, b).split(" ");
  return sm === em ? `${sh}–${eh} ${em}` : `${sh} ${sm}–${eh} ${em}`;
}

/** "11 notifications on 4 days: Sun 19 (7–8 PM), Wed 22 (6–10 PM)." For screen readers, with the charts. */
function summary(d: Hourly, w: Week, notes: number[]): string {
  if (!notes.length) return "No notifications this week.";
  const parts: string[] = [];
  for (const day of w.days) {
    const hs = notes.map((k) => w.from + k).filter((i) => i >= day.first_hour && i < day.first_hour + day.hours);
    if (!hs.length) continue;
    const spans: [number, number][] = [];
    for (const i of hs) {
      const last = spans[spans.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else spans.push([i, i]);
    }
    parts.push(`${shortDay(day.date)} (${spans.map(([a, b]) => hourRange(d, a, b)).join(", ")})`);
  }
  return `${tally(w, notes)}: ${parts.join(", ")}.`;
}

/** The week's days across the top of the charts, each with the unusual signals it had. Clicking one inspects that day. */
function Days({ week, X, current, onPick }: { week: Week; X: XScale; current: string; onPick: (day: Day) => void }) {
  const narrow = X.width < 560;
  return (
    <div className="days" style={{ gridTemplateColumns: week.days.map((x) => `${x.hours}fr`).join(" "), paddingLeft: M.left, paddingRight: M.right }}>
      {week.days.map((day) => (
        <button key={day.date} type="button" className="day" aria-current={day.date === current ? "date" : undefined} onClick={() => onPick(day)}
          aria-label={`${dayLabel(day.date, { weekday: "long", month: "long", day: "numeric" })}: ${day.tags.map((t) => t.text).join("; ") || "nothing unusual"}`}
          title={day.tags.map((t) => t.text).join("\n") || undefined}>
          {narrow
            ? <><span className="wd">{dayLabel(day.date, { weekday: "short" })}</span><b>{Number(day.date.slice(8))}</b></>
            : <b>{shortDay(day.date)}</b>}
          {narrow
            ? day.tags.length > 0 && <span className="day-dots" aria-hidden="true">{"•".repeat(Math.min(3, day.tags.length))}</span>
            : [...day.tags].sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind)).slice(0, 2)
                .map((t) => <span key={t.kind}>{SIGNAL[t.kind] ?? t.kind}</span>)}
          {!narrow && day.tags.length > 2 && <span className="muted">+{day.tags.length - 2} more</span>}
        </button>
      ))}
    </div>
  );
}

interface Shown { run: WeekRun; source: "saved" | "live" }
interface Progress { run: WeekRun | null; text: string; done: number; total: number }

/** Both alerts on the chosen week, the grid data under them, and the hour you pick, side by side. */
function Preview({ d, week, mode, name, threshold, thrValues, thrFlags, thrNotes, run, semNotes, caption, loading, empty, status }: {
  d: Hourly; week: Week; mode: Mode; name: string; threshold: Threshold;
  thrValues: (number | null)[]; thrFlags: boolean[]; thrNotes: number[];
  run: WeekRun | null; semNotes: number[];
  caption: ReactNode; // what the chosen week was like
  loading: boolean; // the description's saved example run is on its way
  empty: ReactNode; // in place of the description's chart until it has a run
  status: ReactNode; // under the description's chart once it has one
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = week.to - week.from;
  const X = useMemo(() => makeX(n, width), [n, width]);
  const compiledAlert = run?.compiled;
  const tree = useMemo(() => (compiledAlert ? parse(compiledAlert.rule, compiledAlert.questions) : null), [compiledAlert]);
  const primary = run?.compiled.primary ?? "";
  const primaryQ = run?.compiled.questions.find((q) => q.id === primary);
  const P = run ? run.answers.map((a) => (a && !a[primary].refused ? a[primary].probs.yes : null)) : null;
  const cut = tree ? cutoffs(tree, primary)[0] : undefined;
  const slice = (key: SeriesKey) => d.series[key].slice(week.from, week.to);
  const series = seriesOf(threshold);
  const mine = mode === "threshold" ? thrNotes : semNotes; // the alert being edited
  const other = mode === "threshold" ? semNotes : thrNotes;

  // The hour under the charts: hovered, else picked, else the first notification of the alert being
  // edited, else the other alert's, else the week's lowest reserves.
  const lowest = (a: number, b: number) => {
    const prc = d.series.prc_min.slice(week.from + a, week.from + b);
    return a + prc.reduce<number>((best, v, j) => (v !== null && v < (prc[best] ?? Infinity) ? j : best), 0);
  };
  const fallback = mine[0] ?? other[0] ?? lowest(0, n);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setPinned(null), [week.start, run?.sentence]);
  const k = Math.min(n - 1, hover ?? pinned ?? fallback);
  const pin = (x: number) => { setPinned(Math.max(0, Math.min(n - 1, x))); setHover(null); };
  const pickDay = (day: Day) => {
    const a = day.first_hour - week.from;
    const inDay = (x: number) => x >= a && x < a + day.hours;
    pin(mine.find(inDay) ?? other.find(inDay) ?? lowest(a, a + day.hours));
  };
  const all = [...new Set([...thrNotes, ...semNotes])].sort((a, b) => a - b);
  const prev = [...all].reverse().find((x) => x < k);
  const next = all.find((x) => x > k);

  // ← → move through the week an hour at a time (a day with shift), except in form fields and the calendar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .cal")) return;
      e.preventDefault();
      pin(k + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 24 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const i = week.from + k;
  const day = dayAt(week, k);
  const at = (m: number) => `${shortDay(dayAt(week, m).date)}, ${hourLabel(d, week.from + m)}`;
  const when = `${at(k)} CT`;
  const common = { X, idx: k, pinned: pinned ?? fallback, onHover: setHover, onPick: pin, dividers: week.days.slice(1).map((x) => x.first_hour - week.from) };
  const reading = threshold.op.startsWith(">") ? (series.hi ? "highest" : "average") : series.lo ? "lowest" : "average";
  const needs = `${OP_LABEL[threshold.op].toLowerCase()} ${threshold.value}`;
  const facts = `Reserves ${orNA(d.series.prc[i], gw)} (low ${orNA(d.series.prc_min[i], gw)}), hub ${orNA(d.series.hub[i], usd)}/MWh (high ${orNA(d.series.hub_max[i], usd)}), ${orNA(d.series.temp[i], deg)}.`;
  const answer = P?.[k] !== null && P?.[k] !== undefined ? pct(P[k]!) : null;

  return (
    <>
      {caption && <p className="week-caption">{caption}</p>}
      <div className="charts" ref={ref}>
        <Days week={week} X={X} current={day.date} onPick={pickDay} />
        <Panel {...common} label={`Threshold alert, ${series.label}, hour by hour, with its notifications. ${summary(d, week, thrNotes)}`} height={78}
          title={<><span className="key-dot thr" />Threshold · <b>{tally(week, thrNotes)}</b> <span className="muted">· {series.label}, {needs}</span></>}
          value={orNA(thrValues[k], (v) => fmtValue(series, v))} values={thrValues}
          yFmt={(v) => (series.unit === "MW" ? `${Math.round(v / 1000)}k` : Math.abs(v) >= 1000 ? `${v / 1000}k` : `${v}`)}
          shade={thrFlags} tone="thr" markers={thrNotes} markerLabel={(m) => `Threshold notification, ${at(m)}`}
          refLine={{ value: threshold.value, tone: "thr" }} />
        {run && P ? (
          <Panel {...common} label={`Description alert, the model's answer hour by hour, with its notifications. ${summary(d, week, semNotes)}`} height={78}
            title={<><span className="key-dot sem" />Describe it · <b>{tally(week, semNotes)}</b> <span className="muted">· the model's answer to “{primaryQ?.text}”{cut !== undefined ? `, notifies at ${pct(cut)}` : ""}</span></>}
            value={answer ?? (run.answers[k] ? "declined" : "…")}
            values={P} domain={[0, 1]} ticks={[0, 0.5, 1]} yFmt={pct} color="var(--sem)" shade={run.rule_true} tone="sem"
            markers={semNotes} markerLabel={(m) => `Description notification, ${at(m)}`}
            refLine={cut !== undefined ? { value: cut, tone: "sem" } : undefined} />
        ) : (
          <div className="lane-empty">
            <div className="panel-head"><span className="panel-title"><span className="key-dot sem" />Describe it <span className="muted">· {loading ? "loading the example run" : "not previewed yet"}</span></span></div>
            {empty}
          </div>
        )}
        {run && status}
        <div className="context">
          {CONTEXT.filter((c) => c.id !== threshold.series).map((c) => (
            <Panel key={c.id} {...common} label={`${c.name}, hourly`} height={40} values={slice(c.key)} yFmt={c.tick}
              band={c.band ? [slice(c.band[0]), slice(c.band[1])] : undefined}
              title={<>{c.name}{c.note && <span className="muted"> · {c.note}</span>}</>} value={orNA(slice(c.key)[k], c.fmt)} />
          ))}
        </div>
      </div>

      <div className="inspect" aria-live="polite">
        <div className="inspect-head">
          <h3 className="inspect-time">{dayLabel(day.date)} <span>{hourLabel(d, i)} hour</span></h3>
          <div className="stepper" role="group" aria-label="Step through notifications">
            <button type="button" className="icon-btn" aria-label="Previous notification" disabled={prev === undefined} onClick={() => prev !== undefined && pin(prev)}>‹</button>
            <span>Notifications</span>
            <button type="button" className="icon-btn" aria-label="Next notification" disabled={next === undefined} onClick={() => next !== undefined && pin(next)}>›</button>
          </div>
        </div>
        <div className="facts">
          <span>Temperature <b>{orNA(d.series.temp[i], deg)}</b></span>
          <span>Demand <b>{orNA(d.series.load[i], gw)}</b></span>
          <span>Hub price <b>{orNA(d.series.hub[i], (x) => `${usd(x)}/MWh`)}</b></span>
          <span>Reserves <b>{orNA(d.series.prc[i], gw)}</b></span>
        </div>
        {day.tags.length > 0 && <p className="day-note"><span className="muted">Unusual that day: </span>{day.tags.map((t) => t.text).join(" · ")}</p>}
        <div className="cols">
          <AlertCol tone="thr">
            {thrNotes.includes(k)
              ? <Mail tone="thr" name={name || "New Alert"} when={when}>
                  {series.label} was {orNA(thrValues[k], (v) => fmtValue(series, v))} at its {reading} this hour, {needs}.
                </Mail>
              : <Quiet>{thrFlags[k] ? "Condition met, but inside the Notification Timeout: no new notification." : "No notification."}</Quiet>}
            <ThresholdCheck label={<>{series.label}, this hour's {reading}</>} value={orNA(thrValues[k], (v) => fmtValue(series, v))}
              met={holds(threshold, thrValues[k])} needs={needs} />
          </AlertCol>
          <AlertCol tone="sem">
            {!run ? <Quiet>Not previewed yet. Preview the description to see what it would have sent.</Quiet>
              : semNotes.includes(k)
                ? <Mail tone="sem" name={name || "New Alert"} when={when}>{primaryQ?.text} Yes, {answer ?? "n/a"}. {facts}</Mail>
                : <Quiet>{!run.answers[k] ? "Not answered yet." : run.rule_true[k] ? "Rule met, but inside the Notification Timeout: no new notification." : "No notification."}</Quiet>}
            {run && tree && <Answers questions={run.compiled.questions} answers={run.answers[k]} tree={tree} />}
            {run && (
              <details className="read">
                <summary>The rule</summary>
                <p>Compiled once by gpt-6-luna{run.compiled.attempts.length > 1 ? `, on attempt ${run.compiled.attempts.length}` : ""}, then checked on every hour in plain code:</p>
                <code className="rule">{run.compiled.rule}</code>
              </details>
            )}
            <details className="read">
              <summary>What the model {run ? "read" : "would read"}</summary>
              <p>{run ? run.prose[k] : snapshot(d, i)}</p>
            </details>
          </AlertCol>
        </div>
      </div>
    </>
  );
}

function CreateAlert({ d }: { d: Hourly }) {
  const initial = useMemo(() => {
    const asked = new URLSearchParams(location.search).get("week");
    const example = d.weeks.find((w) => w.start === asked) ?? d.weeks[0];
    return { example, start: weekOf(d, asked ?? example.start).start };
  }, [d]);
  const [name, setName] = useState(initial.example.name);
  const [mode, setMode] = useState<Mode>("describe");
  const [threshold, setThreshold] = useState<Threshold>(initial.example.threshold);
  const [sentence, setSentence] = useState(initial.example.example);
  const [start, setStart] = useState(initial.start);
  const [timeout, setTimeoutMinutes] = useState<number | null>(null);
  const [emailOn, setEmailOn] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [key, setKey] = useState(() => { try { return sessionStorage.getItem("openai-key") ?? ""; } catch { return ""; } });
  const [saved, setSaved] = useState<Record<string, WeekRun | null>>({});
  const [live, setLive] = useState<WeekRun[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(false);
  const [rerun, setRerun] = useState(false); // the key box, opened under a saved example run
  const compiled = useRef(new Map<string, Compiled>());
  const abort = useRef<AbortController | null>(null);
  const week = useMemo(() => weekOf(d, start), [d, start]);
  const suggested = d.weeks.find((w) => w.start === week.start);
  const sq = sentence.trim();

  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set("week", week.start);
    history.replaceState(null, "", u);
  }, [week.start]);

  useEffect(() => {
    if (!suggested || week.start in saved) return;
    fetch(`${BASE}explore/runs/${week.start}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((run: WeekRun | null) => setSaved((m) => ({ ...m, [week.start]: run })));
  }, [week.start, suggested, saved]);

  useEffect(() => setRerun(false), [week.start, sq]);

  // Only a run made for exactly this description and week: the visitor's own preview, or the saved
  // run of an unchanged example. A custom description starts empty until it's previewed.
  const shown = useMemo<Shown | null>(() => {
    const fits = (r: WeekRun) => r.week === week.start && r.sentence === sq;
    if (progress?.run && fits(progress.run)) return { run: progress.run, source: "live" };
    const mine = [...live].reverse().find(fits);
    if (mine) return { run: mine, source: "live" };
    const sv = saved[week.start];
    return sv && fits(sv) ? { run: sv, source: "saved" } : null;
  }, [progress, live, saved, week.start, sq]);

  const thrValues = useMemo(() => checkedValues(d, threshold, week.from, week.to), [d, threshold, week]);
  const thrFlags = useMemo(() => thrValues.map((v) => holds(threshold, v)), [thrValues, threshold]);
  const thrNotes = useMemo(() => notifications(thrFlags, timeout), [thrFlags, timeout]);
  const semNotes = useMemo(() => (shown ? notifications(shown.run.rule_true, timeout) : []), [shown, timeout]);

  const loadExample = (w: SuggestedWeek) => {
    setName(w.name);
    setThreshold(w.threshold);
    setSentence(w.example);
    setStart(w.start);
    setError(null);
  };

  async function preview() {
    const k = key.trim();
    if (!k.startsWith("sk-")) {
      setError("OpenAI API keys start with “sk-”. Paste a key from platform.openai.com/api-keys.");
      return;
    }
    setError(null);
    const ctl = new AbortController();
    abort.current = ctl;
    try { sessionStorage.setItem("openai-key", k); } catch { /* storage unavailable */ }
    const total = week.to - week.from;
    const known = compiled.current.get(sq);
    setProgress({ run: null, text: known ? "Answering each hour" : "Compiling the description", done: 0, total });
    try {
      const result = await runWeek({ key: k, signal: ctl.signal }, d, week.start, sq, {
        compiled: known,
        onProgress: (p) => setProgress(p.phase === "compiling"
          ? { run: null, text: `Compiling the description${p.attempt > 1 ? `, attempt ${p.attempt} of 3` : ""}`, done: 0, total }
          : { run: { ...p.run, answers: [...p.run.answers], rule_true: [...p.run.rule_true] }, text: "Answering each hour", done: p.done, total }),
      });
      compiled.current.set(sq, result.compiled);
      setLive((l) => [...l, result]);
    } catch (e) {
      if (!ctl.signal.aborted) setError(describe(e));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  }

  const hours = week.to - week.from;
  const cost = ((hours * TOKENS_PER_HOUR) / 1e6) * USD_PER_M_INPUT;
  const series = seriesOf(threshold);
  const isExample = (w: SuggestedWeek) => w.start === week.start && w.example === sq;
  const unusual = week.days.filter((x) => x.tags.length).length;
  const stats = shown?.source === "live" ? shown.run.stats : null;
  // An unchanged example whose saved run is still downloading: don't ask for a key it won't need.
  const loading = !shown && !!suggested && suggested.example === sq && !(week.start in saved);

  // The description's preview, in the place its chart will appear: the key and a button, or progress.
  const keyBox = (
    <div className="runner">
      <p className="runner-title">{shown ? "Run this description with your own key" : `Preview your description on ${weekLabel(week)}`}</p>
      <div className="runner-row">
        <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Your OpenAI API key (sk-…)"
          aria-label="Your OpenAI API key" autoComplete="off" spellCheck={false} />
        <button type="button" className="btn" disabled={!key.trim() || sq.length < 8} onClick={preview}>Preview</button>
      </div>
      <p className="hint">
        {sq.length < 8 ? "Describe the condition first. " : ""}
        gpt-6-luna checks each of the {hours} hours from your browser, for about ${cost.toFixed(3)}. Your key stays in this tab and goes
        only to api.openai.com.{compiled.current.has(sq) ? " This description is already compiled, so the preview reuses it." : ""}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
  const running = progress && (
    <div className="runner running">
      <div className="runner-row">
        <span><b>{progress.text}</b>{progress.total && progress.done ? ` · ${progress.done} of ${progress.total} hours` : "…"}</span>
        <button type="button" className="btn secondary" onClick={() => abort.current?.abort()}>Stop</button>
      </div>
      <div className="progress" role="progressbar" aria-label="Preview progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
      </div>
    </div>
  );
  const status = running || (
    <div className="lane-status">
      {shown?.source === "saved" ? (
        <p>
          Saved example run from {new Date(shown.run.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, no key needed.{" "}
          <button type="button" className="link" aria-expanded={rerun} onClick={() => setRerun(!rerun)}>Run it yourself</button>
        </p>
      ) : stats && (
        <p>Your run: {stats.calls} hours checked for ${stats.cost_usd.toFixed(4)}, a median of {stats.latency_ms.median} ms each.{stats.refusals > 0 ? ` The model declined ${stats.refusals} answers; a declined answer counts as not met.` : ""}</p>
      )}
      {rerun && shown?.source === "saved" && keyBox}
    </div>
  );

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Proposed enhancement to Grid Status alerts</p>
        <h1>Create alert</h1>
        <p className="lede">Describe a condition in your own words, then see when it would have notified you.</p>
      </header>

      <div className="examples">
        <span className="label">Start from an example</span>
        <div className="chips" role="group" aria-label="Examples">
          {d.weeks.map((w) => (
            <button key={w.start} type="button" className="chip" aria-pressed={isExample(w)} onClick={() => loadExample(w)}
              title={weekLabel(weekOf(d, w.start))}>{w.title}</button>
          ))}
        </div>
      </div>

      <div className="builder">
        <div className="card f1">
          <Section title="Name your alert" help="You will see this name when receiving notifications">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Alert name" placeholder="New Alert" />
          </Section>

          <Section title="What would you like to monitor?" help="The alert will be triggered if the condition is met for any new row in the dataset since the last time the alert was run.">
            <Segmented label="How to monitor" value={mode} onChange={setMode} options={[
              { value: "threshold", label: <><span className="key-dot thr" />Threshold</> },
              { value: "describe", label: <><span className="key-dot sem" />Describe it<span className="badge">New</span></> },
            ]} />
            {mode === "threshold" ? (
              <>
                <div className="series-row">
                  <Field label="Select Series">
                    <Select label="Series" value={threshold.series} options={SERIES.map((s) => ({ value: s.id, label: s.label }))}
                      onChange={(id) => setThreshold({ series: id, ...(SERIES.find((s) => s.id === id) ?? SERIES[0]).start })} />
                  </Field>
                  <Field label="Is">
                    <Select label="Operator" value={threshold.op} options={OPS.map((o) => ({ value: o.op, label: o.label }))}
                      onChange={(op) => setThreshold({ ...threshold, op })} />
                  </Field>
                  <Field label="Value">
                    <NumberInput label="Value" value={threshold.value} unit={series.unit} step={series.unit === "MW" ? 500 : series.unit === "°F" ? 1 : 10}
                      onChange={(v) => setThreshold({ ...threshold, value: v ?? 0 })} />
                  </Field>
                </div>
                <p className="hint">The preview uses hourly data: “greater than” checks each hour's highest value where there is one, and “less than” its lowest.</p>
              </>
            ) : (
              <>
                <Field label="Describe the condition">
                  <textarea className="input" rows={3} value={sentence} maxLength={300} onChange={(e) => setSentence(e.target.value)}
                    aria-label="Describe the condition" placeholder="Tell me when…" />
                </Field>
                <p className="hint">
                  The model reads one hourly snapshot at a time: temperature, demand, solar, wind, batteries, prices and reserves.{" "}
                  <button type="button" onClick={() => setSample(!sample)} aria-expanded={sample}>{sample ? "Hide the example hour" : "See an example hour"}</button>
                </p>
                {sample && <p className="sample">{snapshot(d, week.from + 20)}</p>}
              </>
            )}
          </Section>

          <Section title="Notification Timeout" help="After the alert is triggered, how long should we wait before sending another notification?">
            <NumberInput className="w-sm" label="Notification timeout in minutes" value={timeout} min={0} step={30} unit="minutes"
              placeholder="No timeout" onChange={setTimeoutMinutes} />
          </Section>
        </div>

        <section className="card pv" aria-labelledby="preview-title">
          <div className="pv-head">
            <h2 className="section-title" id="preview-title">Preview<span className="badge">New</span></h2>
            <div className="week-nav">
              <button type="button" className="icon-btn" aria-label="Previous week" disabled={week.start === d.days[0].date}
                onClick={() => setStart(weekOf(d, addDays(week.start, -7)).start)}>‹</button>
              <span className="week-label">{weekLabel(week)}</span>
              <button type="button" className="icon-btn" aria-label="Next week" disabled={week.start === lastStart(d)}
                onClick={() => setStart(weekOf(d, addDays(week.start, 7)).start)}>›</button>
            </div>
          </div>
          <p className="section-help">Click any day to preview the week from there. Darker days had more unusual signals.</p>
          <Calendar d={d} week={week} onPick={(s) => setStart(weekOf(d, s).start)} />
          <Preview d={d} week={week} mode={mode} name={name} threshold={threshold}
            thrValues={thrValues} thrFlags={thrFlags} thrNotes={thrNotes} run={shown?.run ?? null} semNotes={semNotes}
            caption={suggested ? <><b>{suggested.title}.</b> {suggested.note}</>
              : unusual ? null : "Nothing unusual this week by these measures, which makes it a good test of whether an alert stays quiet."}
            loading={loading} empty={running || (loading ? <p className="runner muted">Loading the example run…</p> : keyBox)} status={status} />
        </section>

        <div className="card f2">
          <Section title="How should you be notified?" help="When the alert is enabled, notifications will be sent via these methods. Notifications can only be sent to the primary email address and/or phone number on your account.">
            <div className="method">
              <div>
                <div className="method-name"><MailIcon />Email</div>
                <div className="method-addr">you@example.com</div>
              </div>
              <Toggle on={emailOn} onChange={setEmailOn} label={emailOn ? "On" : "Off"} />
            </div>
            <Callout>
              Sentence alerts can say why they fired: each notification carries a one-line reason written from the same row.{" "}
              <a href={`${BASE}#t=20:10`}>See examples from July 22</a>
            </Callout>
          </Section>

          <Section title="Alert Status">
            <Toggle on={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
          </Section>

          <div className="form-foot">
            <button type="button" className="btn" disabled>Create</button>
            <span className="muted small">Concept demo: alerts aren't saved or sent.</span>
          </div>
        </div>
      </div>
    </>
  );
}

export default function ExploreApp() {
  const [d, setD] = useState<Hourly | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${BASE}explore/ercot_hourly.json`).then((r) => r.json()).then(setD).catch((e) => setErr(String(e)));
  }, []);
  return (
    <Shell page="create" footer={
      <>
        <p>Hourly data from the Grid Status API{d ? ` (${d.datasets.join(", ")})` : ""}, {d ? `${dayLabel(d.range.first_day, { month: "short", day: "numeric", year: "numeric" })} to ${dayLabel(d.range.last_day, { month: "short", day: "numeric", year: "numeric" })}` : ""}. Times are US Central.</p>
        <p>Previews of a description call OpenAI's gpt-6-luna from this page with your key: the Responses API compiles the sentence, the Decisions API answers each hour. Nothing is stored on a server.</p>
      </>
    }>
      {err && <p className="bad page-head">Couldn't load the data: {err}</p>}
      {!d && !err && <p className="muted page-head">Loading ten months of ERCOT data…</p>}
      {d && <CreateAlert d={d} />}
    </Shell>
  );
}
