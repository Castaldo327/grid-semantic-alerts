import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, makeX, useWidth, type Tick } from "../chart";
import { cutoffs, parse } from "../rule";
import { Answers, BASE, Callout, Field, Mail, MailIcon, NumberInput, Section, Segmented, Select, Shell, Toggle, gw, orNA, pct, usd } from "../site";
import { Calendar } from "./Calendar";
import type { Compiled } from "./compile";
import { addDays, dayLabel, hourLabel, lastStart, weekLabel, weekOf, type Hourly, type SeriesKey, type SuggestedWeek, type Week } from "./data";
import { USD_PER_M_INPUT, describe } from "./openai";
import { runWeek, type WeekRun } from "./run";
import { OPS, SERIES, checkedValues, holds, notifications, seriesOf, type SeriesOption, type Threshold } from "./series";
import { snapshot } from "./snapshot";

type Mode = "threshold" | "describe";
const TOKENS_PER_HOUR = 600; // measured: 515-540 input tokens per snapshot with two questions, 675 with three
const OP_LABEL = Object.fromEntries(OPS.map((o) => [o.op, o.label]));
const deg = (f: number) => `${Math.round(f)}°F`;

const fmtValue = (s: SeriesOption, v: number) =>
  s.unit === "°F" ? deg(v) : s.unit === "$/MWh" ? `${usd(v)}/MWh` : `${Math.round(v).toLocaleString("en-US")} MW`;
const shortDay = (date: string) => `${dayLabel(date, { weekday: "short" })} ${Number(date.slice(8))}`;

/** "6–10 PM" for notifications at the hours starting a..b, or "11 AM–1 PM". */
function hourRange(d: Hourly, a: number, b: number): string {
  if (a === b) return hourLabel(d, a);
  const [sh, sm] = hourLabel(d, a).split(" ");
  const [eh, em] = hourLabel(d, b).split(" ");
  return sm === em ? `${sh}–${eh} ${em}` : `${sh} ${sm}–${eh} ${em}`;
}

/** "11 notifications on 4 days: Sun 19 (7–8 PM), Wed 22 (6–10 PM)." */
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
  const s = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${s(notes.length, "notification")} on ${s(parts.length, "day")}: ${parts.join(", ")}.`;
}

interface Shown { run: WeekRun; source: "saved" | "live" }
interface Progress { run: WeekRun | null; text: string; done: number; total: number }

function Preview({ d, week, mode, setMode, name, threshold, thrValues, thrFlags, thrNotes, shown, semNotes, progress }: {
  d: Hourly; week: Week; mode: Mode; setMode: (m: Mode) => void; name: string; threshold: Threshold;
  thrValues: (number | null)[]; thrFlags: boolean[]; thrNotes: number[];
  shown: Shown | null; semNotes: number[]; progress: Progress | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = week.to - week.from;
  const X = useMemo(() => makeX(n, width), [n, width]);
  const run = shown?.run ?? null;
  const compiledAlert = run?.compiled;
  const tree = useMemo(() => (compiledAlert ? parse(compiledAlert.rule, compiledAlert.questions) : null), [compiledAlert]);
  const primary = run?.compiled.primary ?? "";
  const primaryQ = run?.compiled.questions.find((q) => q.id === primary);
  const P = run ? run.answers.map((a) => (a && !a[primary].refused ? a[primary].probs.yes : null)) : null;
  const cut = tree ? cutoffs(tree, primary)[0] : undefined;
  const slice = (key: SeriesKey) => d.series[key].slice(week.from, week.to);
  const series = seriesOf(threshold);
  const isThr = mode === "threshold";
  const notes = isThr ? thrNotes : run ? semNotes : [];

  // The hour shown below the charts: the first notification, else the week's lowest reserves.
  const fallback = useMemo(() => {
    if (notes.length) return notes[0];
    const prc = d.series.prc_min.slice(week.from, week.to);
    return prc.reduce<number>((best, v, k) => (v !== null && v < (prc[best] ?? Infinity) ? k : best), 0);
  }, [notes, d, week.from, week.to]);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setPinned(null), [week.start, mode, run?.sentence]);
  const k = hover ?? pinned ?? fallback;
  const i = week.from + k;

  const dividers = week.days.slice(1).map((day) => day.first_hour - week.from);
  const axis: Tick[] = week.days.map((day) => ({
    i: day.first_hour - week.from + Math.floor(day.hours / 2), label: width < 560 ? String(Number(day.date.slice(8))) : shortDay(day.date),
    mark: day.tags.length > 0, title: day.tags.map((t) => t.text).join("\n") || undefined,
  }));
  const common = { X, idx: k, pinned: pinned ?? fallback, onHover: setHover, onPick: setPinned, dividers };
  const stats = run?.stats;
  const day = week.days.find((x) => i >= x.first_hour && i < x.first_hour + x.hours)!;
  const when = `${shortDay(day.date)}, ${hourLabel(d, i)} CT`;
  const reading = threshold.op.startsWith(">") ? (series.hi ? "highest" : "average") : series.lo ? "lowest" : "average";
  const facts = `Reserves ${orNA(d.series.prc[i], gw)} (low ${orNA(d.series.prc_min[i], gw)}), hub ${orNA(d.series.hub[i], usd)}/MWh (high ${orNA(d.series.hub_max[i], usd)}), ${orNA(d.series.temp[i], deg)}.`;

  const status = isThr ? "Computed from the data instantly, with no model calls."
    : progress ? <><b>{progress.text}</b>{progress.total && progress.done ? ` · ${progress.done} of ${progress.total} hours` : "…"}</>
    : !shown ? "Add your key and preview the description to see the model's answers."
    : shown.source === "saved" ? <><b>Example preview</b> · saved {new Date(shown.run.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · add your key to preview it yourself</>
    : stats ? <><b>Your preview</b> · {stats.calls} decisions · {stats.input_tokens.toLocaleString("en-US")} input tokens · ${stats.cost_usd.toFixed(4)} · median {stats.latency_ms.median} ms</>
    : null;

  return (
    <div className="preview">
      <div className="preview-head">
        <h3>{weekLabel(week)}</h3>
        <span className="status">{status}</span>
      </div>
      {!isThr && progress && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
        </div>
      )}

      <div className="tally" role="group" aria-label="Notifications this week">
        <button type="button" aria-pressed={isThr} onClick={() => setMode("threshold")}>
          <div className="t-head"><span className="key-dot thr" />Threshold</div>
          <div className="t-n">{thrNotes.length}<small>notification{thrNotes.length === 1 ? "" : "s"}</small></div>
          <div className="t-def">{series.label} · {OP_LABEL[threshold.op].toLowerCase()} {threshold.value}</div>
        </button>
        <button type="button" aria-pressed={!isThr} onClick={() => setMode("describe")}>
          <div className="t-head"><span className="key-dot sem" />Describe it</div>
          <div className="t-n">{run ? semNotes.length : "–"}<small>{run ? `notification${semNotes.length === 1 ? "" : "s"}` : "not previewed yet"}</small></div>
          <div className="t-def">{run ? `“${run.sentence}”` : "Preview the description to compare"}</div>
        </button>
      </div>

      {!isThr && run && (
        <>
          <div className="compiled">
            <span className="muted">Compiled once by gpt-6-luna{run.compiled.attempts.length > 1 ? `, on attempt ${run.compiled.attempts.length}` : ""}, and checked on every hour as:</span>
            <ol>
              {run.compiled.questions.map((q) => (
                <li key={q.id}>{q.text} <span className="opts">({q.kind === "probability" ? "yes / no" : q.options.join(" / ")})</span></li>
              ))}
            </ol>
            <code className="rule">{run.compiled.rule}</code>
          </div>
        </>
      )}
      {(isThr || run) && (
        <p className="summary">
          {summary(d, week, notes)}
          {!isThr && stats && stats.refusals > 0 ? ` The model declined ${stats.refusals} answers; a declined answer counts as not met.` : ""}
        </p>
      )}

      <div className="panels" ref={ref}>
        {isThr ? (
          <Panel {...common} label={`${series.label}, hourly, with the threshold and its notifications`} height={96}
            title={<>{series.label} <span className="muted">· each hour's {reading}</span></>}
            value={orNA(thrValues[k], (v) => fmtValue(series, v))} values={thrValues}
            yFmt={(v) => (series.unit === "MW" ? `${Math.round(v / 1000)}k` : Math.abs(v) >= 1000 ? `${v / 1000}k` : `${v}`)}
            shade={thrFlags} tone="thr" markers={thrNotes} markerLabel={(m) => `Notification, ${hourLabel(d, week.from + m)}`}
            refLine={{ value: threshold.value, label: `${OP_LABEL[threshold.op].toLowerCase()} ${threshold.value}`, tone: "thr", align: "start" }} />
        ) : run && P ? (
          <Panel {...common} label="The model's answer to the main question, hour by hour, with notifications" height={104}
            title={<>Model's answer <span className="muted">· “{primaryQ?.text}”</span></>}
            value={P[k] !== null && P[k] !== undefined ? pct(P[k]!) : run.answers[k] ? "declined" : "…"}
            values={P} domain={[0, 1]} ticks={[0, 0.5, 1]} yFmt={pct} color="var(--sem)" shade={run.rule_true} tone="sem"
            markers={run ? semNotes : undefined} markerLabel={(m) => `Notification, ${hourLabel(d, week.from + m)}`}
            refLine={cut !== undefined ? { value: cut, label: `notifies at ${pct(cut)}`, tone: "sem", align: "start" } : undefined} />
        ) : null}
        <Panel {...common} label="ERCOT demand, hourly" title="ERCOT Load: load, GW" value={orNA(slice("load")[k], gw)}
          values={slice("load")} yFmt={(v) => `${Math.round(v / 1000)}`} height={56} />
        <Panel {...common} label="Demand-weighted temperature across ERCOT, hourly" title={<>Temperature, °F <span className="muted">· weighted by where demand is</span></>}
          value={orNA(slice("temp")[k], deg)} values={slice("temp")} yFmt={(v) => `${v}`} height={52} />
        <Panel {...common} label="Hub real-time price, hourly average with the hour's range" title={<>ERCOT LMP By Settlement Point: lmp (HB_HUBAVG), $/MWh <span className="muted">· average and range</span></>}
          value={orNA(slice("hub")[k], (x) => `${usd(x)}/MWh`)} values={slice("hub")} band={[slice("hub_min"), slice("hub_max")]}
          yFmt={(v) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : `${v}`)} height={56} />
        <Panel {...common} label="Operating reserves, hourly average with the hour's low" title={<>ERCOT PRC: prc, GW <span className="muted">· average and low</span></>}
          value={orNA(slice("prc")[k], gw)} values={slice("prc")} band={[slice("prc_min"), slice("prc")]}
          yFmt={(v) => `${Math.round(v / 1000)}`} height={56} />
        <Panel {...common} label="Wind output, hourly" title="ERCOT Fuel Mix: wind, GW" value={orNA(slice("wind")[k], gw)}
          values={slice("wind")} yFmt={(v) => `${Math.round(v / 1000)}`} height={52} axis={axis} />
      </div>

      <div className="hour" aria-run="polite">
        <div>
          <div className="hour-time">{dayLabel(day.date)} · {hourLabel(d, i)} hour</div>
          <div className="facts">
            <span>Temperature <b>{orNA(d.series.temp[i], deg)}</b></span>
            <span>Demand <b>{orNA(d.series.load[i], gw)}</b></span>
            <span>Hub <b>{orNA(d.series.hub[i], usd)}</b></span>
            <span>Reserves <b>{orNA(d.series.prc[i], gw)}</b></span>
          </div>
          <div className="sub">Notification</div>
          {notes.includes(k) ? (
            isThr
              ? <Mail tone="thr" name={name || "New Alert"} when={when}>
                  {series.label} was {orNA(thrValues[k], (v) => fmtValue(series, v))} at its {reading} this hour, {OP_LABEL[threshold.op].toLowerCase()} {threshold.value}.
                </Mail>
              : <Mail tone="sem" name={name || "New Alert"} when={when}>
                  {primaryQ?.text} Yes, {P?.[k] !== null && P?.[k] !== undefined ? pct(P[k]!) : "n/a"}. {facts}
                </Mail>
          ) : (
            <div className="status-line">
              <span className={`key-dot ${isThr ? "thr" : "sem"}`} />
              <b>{isThr ? (thrFlags[k] ? "Condition met, inside the notification timeout" : "No notification: the condition isn't met")
                : !run ? "Preview the description to see this hour"
                : !run?.answers[k] ? "Not answered yet"
                : run.rule_true[k] ? "Rule met, inside the notification timeout" : "No notification: the rule isn't met"}</b>
            </div>
          )}
          {isThr
            ? <details className="read"><summary>The hourly snapshot a sentence alert would read</summary><p>{snapshot(d, i)}</p></details>
            : <p className="read-text"><span className="muted">What the model {run ? "read" : "would read"}: </span>{run ? run.prose[k] : snapshot(d, i)}</p>}
        </div>
        <div>
          {isThr ? (
            <div>
              <div className="q">{series.label}</div>
              <div className="facts">This hour's {reading} <b>{orNA(thrValues[k], (v) => fmtValue(series, v))}</b></div>
              <div className="conds">
                <span className={holds(threshold, thrValues[k]) ? "met" : ""}>
                  {holds(threshold, thrValues[k]) ? "✓" : "✗"} needs {OP_LABEL[threshold.op].toLowerCase()} {threshold.value}
                </span>
              </div>
            </div>
          ) : run && tree
            ? <Answers questions={run.compiled.questions} answers={run.answers[k]} tree={tree} />
            : <p className="muted small">Preview the description to see the model's answers for each hour. Hover over the charts to move through the week.</p>}
        </div>
      </div>
    </div>
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
  const unusual = week.days.filter((x) => x.tags.length);
  const series = seriesOf(threshold);
  const isExample = (w: SuggestedWeek) => w.start === week.start && w.example === sq;
  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Proposed enhancement to Grid Status alerts</p>
        <h1>Create alert</h1>
        <p className="lede">
          The alert form with one new way to monitor: describe the condition in a sentence. Preview when it would have notified
          you on any week from Dec 5, 2025 to Oct 8, 2026, next to the threshold you'd set today.
        </p>
      </header>

      <div className="card">
        <div className="examples">
          <span className="label">Start from an example</span>
          <div className="chips" role="group" aria-label="Examples">
            {d.weeks.map((w) => (
              <button key={w.start} type="button" className="chip" aria-pressed={isExample(w)} onClick={() => loadExample(w)}>
                {w.title}<span>{weekLabel(weekOf(d, w.start)).replace(/, \d{4}$/, "")}</span>
              </button>
            ))}
          </div>
        </div>

        <Section title="Name your alert" help="You will see this name when receiving notifications">
          <input className="input w-md" value={name} onChange={(e) => setName(e.target.value)} aria-label="Alert name" placeholder="New Alert" />
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
              <p className="hint">
                The preview uses hourly data. “Greater than” reads each hour's highest value where Grid Status has one (the 5-minute
                peak, the highest SCED price) and “less than” its lowest, so it notifies when any row in the hour would.
              </p>
            </>
          ) : (
            <>
              <Field label="Describe the condition">
                <textarea className="input" rows={2} value={sentence} maxLength={300} onChange={(e) => setSentence(e.target.value)}
                  aria-label="Describe the condition" placeholder="Tell me when…" />
              </Field>
              <p className="hint">
                It's checked against one hourly snapshot at a time: temperature, demand, solar, wind, batteries, prices and reserves,
                nothing else.{" "}
                <button type="button" onClick={() => setSample(!sample)} aria-expanded={sample}>{sample ? "Hide the example" : "See an example hour"}</button>
              </p>
              {sample && <p className="sample">{snapshot(d, week.from + 20)}</p>}
            </>
          )}
        </Section>

        <Section title="Preview" badge="New" help="See when this alert would have notified you. Pick any week; shaded days had something unusual.">
          <Calendar d={d} week={week} onPick={(s) => setStart(weekOf(d, s).start)} />
          <div className="week-bar">
            <span className="label">{weekLabel(week)}</span>
            <button type="button" className="icon-btn" aria-label="Previous week" disabled={week.start === d.days[0].date}
              onClick={() => setStart(weekOf(d, addDays(week.start, -7)).start)}>‹</button>
            <button type="button" className="icon-btn" aria-label="Next week" disabled={week.start === lastStart(d)}
              onClick={() => setStart(weekOf(d, addDays(week.start, 7)).start)}>›</button>
          </div>
          {suggested && <p className="week-note">{suggested.note}</p>}
          {unusual.length > 0
            ? <ul className="unusual">{unusual.map((x) => <li key={x.date}><b>{shortDay(x.date)}</b>{x.tags.map((t) => t.text).join(" · ")}</li>)}</ul>
            : <p className="week-note">Nothing unusual this week by these measures, which makes it a good test of whether an alert stays quiet.</p>}

          {mode === "describe" && (
            <>
              <div className="run-row">
                <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Your OpenAI API key (sk-…)"
                  aria-label="Your OpenAI API key" autoComplete="off" spellCheck={false} />
                {progress
                  ? <button type="button" className="btn secondary" onClick={() => abort.current?.abort()}>Stop</button>
                  : <button type="button" className="btn" disabled={!key.trim() || sq.length < 8} onClick={preview}>Preview description</button>}
              </div>
              <p className="hint">
                In this concept the preview calls OpenAI's gpt-6-luna from your browser with your own key, which stays in this tab and
                goes only to api.openai.com. It compiles the sentence once, then makes {hours} Decisions API calls: about{" "}
                {Math.round((hours * TOKENS_PER_HOUR) / 1000)},000 input tokens, roughly ${((hours * TOKENS_PER_HOUR) / 1e6 * USD_PER_M_INPUT).toFixed(3)}.
                {compiled.current.has(sq) ? " This description is already compiled, so the preview reuses it." : ""}
              </p>
              {error && <p className="error" role="alert">{error}</p>}
            </>
          )}

          <Preview d={d} week={week} mode={mode} setMode={setMode} name={name} threshold={threshold}
            thrValues={thrValues} thrFlags={thrFlags} thrNotes={thrNotes} shown={shown} semNotes={semNotes} progress={progress} />
        </Section>

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

        <Section title="Notification Timeout" help="After the alert is triggered, how long should we wait before sending another notification?">
          <NumberInput className="w-sm" label="Notification timeout in minutes" value={timeout} min={0} step={30} unit="minutes"
            placeholder="No timeout" onChange={setTimeoutMinutes} />
          <p className="hint">The preview applies it to both alerts. With no timeout, every hour where the condition holds sends a notification.</p>
        </Section>

        <Section title="Alert Status">
          <Toggle on={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
        </Section>

        <div className="form-foot">
          <button type="button" className="btn" disabled>Create</button>
          <span className="muted small">Concept demo: alerts aren't saved or sent.</span>
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
