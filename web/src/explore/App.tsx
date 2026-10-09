import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, makeX, useWidth, type Tick } from "../chart";
import { cutoffs, parse } from "../rule";
import { Answers, BASE, Shell, gw, orNA, pct, usd } from "../site";
import { Calendar } from "./Calendar";
import type { Compiled } from "./compile";
import { addDays, dayLabel, hourLabel, lastStart, weekLabel, weekOf, type Hourly, type SeriesKey, type Week } from "./data";
import { USD_PER_M_INPUT, describe } from "./openai";
import { runWeek, type WeekRun } from "./run";
import { snapshot } from "./snapshot";

const TOKENS_PER_HOUR = 500; // measured: 470-540 input tokens per snapshot with two questions

/** "7–9 PM" for hours a..b (inclusive), or "11 AM–1 PM". */
function hourSpan(d: Hourly, a: number, b: number): string {
  const [sh, sm] = hourLabel(d, a).split(" ");
  const [eh, em] = hourLabel(d, b + 1).split(" ");
  return sm === em ? `${sh}–${eh} ${em}` : `${sh} ${sm}–${eh} ${em}`;
}

const shortDay = (date: string) => `${dayLabel(date, { weekday: "short" })} ${Number(date.slice(8))}`;

/** "Rule met in 14 of 168 hours, on 4 days: Sun 19 (7–9 PM), ..." */
function summary(d: Hourly, w: Week, run: WeekRun): string {
  const parts: string[] = [];
  let total = 0;
  for (const day of w.days) {
    const spans: string[] = [];
    let a = -1;
    for (let i = day.first_hour; i <= day.first_hour + day.hours; i++) {
      const on = i < day.first_hour + day.hours && run.rule_true[i - run.from];
      if (on) total++;
      if (on && a < 0) a = i;
      if (!on && a >= 0) { spans.push(hourSpan(d, a, i - 1)); a = -1; }
    }
    if (spans.length) parts.push(`${shortDay(day.date)} (${spans.join(", ")})`);
  }
  const answered = run.answers.filter(Boolean).length;
  if (!total) return `The rule wasn't met in any of the ${answered} hours${answered < run.answers.length ? " answered so far" : ""}.`;
  return `Rule met in ${total} of ${answered} hours, on ${parts.length} day${parts.length > 1 ? "s" : ""}: ${parts.join(", ")}.`;
}

interface Shown { run: WeekRun; source: "saved" | "live"; stale: boolean }

function Results({ d, week, shown, progress }: { d: Hourly; week: Week; shown: Shown | null; progress: { text: string; done: number; total: number } | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = week.to - week.from;
  const X = useMemo(() => makeX(n, width), [n, width]);
  const run = shown?.run ?? null;
  const compiledAlert = run?.compiled;
  const tree = useMemo(() => (compiledAlert ? parse(compiledAlert.rule, compiledAlert.questions) : null), [compiledAlert]);
  const primary = run?.compiled.primary ?? "";
  const P = run ? run.answers.map((a) => (a && !a[primary].refused ? a[primary].probs.yes : null)) : null;
  const cut = tree ? cutoffs(tree, primary)[0] : undefined;
  const slice = (k: SeriesKey) => d.series[k].slice(week.from, week.to);

  // Pinned hour: the first alert, else the week's lowest reserves.
  const fallback = useMemo(() => {
    const first = run ? run.rule_true.findIndex(Boolean) : -1;
    if (first >= 0) return first;
    const prc = d.series.prc_min.slice(week.from, week.to);
    return prc.reduce<number>((best, v, k) => (v !== null && v < (prc[best] ?? Infinity) ? k : best), 0);
  }, [run, week.from, week.to, d]);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setPinned(null), [week.start, run?.sentence]);
  const k = hover ?? pinned ?? fallback;
  const i = week.from + k;

  const dividers = week.days.slice(1).map((day) => day.first_hour - week.from);
  const axis: Tick[] = week.days.map((day) => ({
    i: day.first_hour - week.from + Math.floor(day.hours / 2), label: width < 560 ? String(Number(day.date.slice(8))) : shortDay(day.date),
    mark: day.tags.length > 0, title: day.tags.map((t) => t.text).join("\n") || undefined,
  }));
  const common = { X, idx: k, pinned: pinned ?? fallback, onHover: setHover, onPick: setPinned, dividers };
  const stats = run?.stats;

  return (
    <section>
      <div className="result-head">
        <h2>{weekLabel(week)}</h2>
        <span className="status">
          {progress ? <><b>{progress.text}</b>{progress.total && progress.done ? ` · ${progress.done} of ${progress.total} hours` : "…"}</>
            : !shown ? "Grid data for the week. Run an alert to add the model's answers."
            : shown.source === "saved" ? <><b>Saved run</b> · {new Date(shown.run.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · add your key to run it yourself</>
            : stats ? <><b>Your run</b> · {stats.calls} decisions · {stats.input_tokens.toLocaleString("en-US")} input tokens · ${stats.cost_usd.toFixed(4)} · median {stats.latency_ms.median} ms</>
            : null}
        </span>
      </div>
      {progress && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>}

      {run && (
        <>
          {shown?.stale && <p className="stale-note">Showing the {shown.source === "saved" ? "saved run" : "earlier run"} for “{run.sentence}”. Run to see yours.</p>}
          <div className="compiled">
            <span className="muted">Compiled once by gpt-6-luna{run.compiled.attempts.length > 1 ? `, on attempt ${run.compiled.attempts.length}` : ""}:</span>
            <ol>
              {run.compiled.questions.map((q) => (
                <li key={q.id}>{q.text} <span className="opts">({q.kind === "probability" ? "yes / no" : q.options.join(" / ")})</span></li>
              ))}
            </ol>
            <code className="rule">{run.compiled.rule}</code>
          </div>
          <p className="summary">{summary(d, week, run)}{stats && stats.refusals > 0 ? ` The model declined ${stats.refusals} answers; a declined answer counts as not met.` : ""}</p>
        </>
      )}

      <div className={`panels${shown?.stale ? " dim" : ""}`} ref={ref}>
        {run && P && (
          <Panel {...common} label="The model's answer to the main question, hour by hour" height={104}
            title={<>Model's answer <span className="muted">· “{run.compiled.questions.find((q) => q.id === primary)?.text}”</span></>}
            value={P[k] !== null && P[k] !== undefined ? pct(P[k]!) : run.answers[k] ? "declined" : "…"}
            values={P} domain={[0, 1]} ticks={[0, 0.5, 1]} yFmt={pct} color="var(--sem)" shade={run.rule_true} tone="sem"
            refLine={cut !== undefined ? { value: cut, label: `alerts at ${pct(cut)}`, tone: "sem", align: "start" } : undefined} />
        )}
        <Panel {...common} label="ERCOT demand, hourly" title="Demand, GW" value={orNA(slice("load")[k], gw)}
          values={slice("load")} yFmt={(v) => `${Math.round(v / 1000)}`} height={64} />
        <Panel {...common} label="Hub real-time price, hourly average with the hour's range" title={<>Hub price, $/MWh <span className="muted">· hourly average and range</span></>}
          value={orNA(slice("hub")[k], (x) => `${usd(x)}/MWh`)} values={slice("hub")} band={[slice("hub_min"), slice("hub_max")]}
          yFmt={(v) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : `${v}`)} height={64} />
        <Panel {...common} label="Operating reserves, hourly average with the hour's low" title={<>Operating reserves, GW <span className="muted">· average and low</span></>}
          value={orNA(slice("prc")[k], gw)} values={slice("prc")} band={[slice("prc_min"), slice("prc")]}
          yFmt={(v) => `${Math.round(v / 1000)}`} height={64} />
        <Panel {...common} label="Wind output, hourly" title="Wind, GW" value={orNA(slice("wind")[k], gw)}
          values={slice("wind")} yFmt={(v) => `${Math.round(v / 1000)}`} height={56} axis={axis} />
      </div>

      <div className="hour" aria-live="polite">
        <div>
          <div className="hour-time">{dayLabel(week.days.find((x) => i >= x.first_hour && i < x.first_hour + x.hours)!.date)} · {hourSpan(d, i, i)}</div>
          <div className="facts">
            <span>Demand <b>{orNA(d.series.load[i], gw)}</b></span>
            <span>Hub <b>{orNA(d.series.hub[i], usd)}</b>{d.series.hub_max[i] !== null && <> (high {usd(d.series.hub_max[i]!)})</>}</span>
            <span>Reserves <b>{orNA(d.series.prc[i], gw)}</b>{d.series.prc_min[i] !== null && <> (low {gw(d.series.prc_min[i]!)})</>}</span>
          </div>
          {run && (
            <p className="verdict-line" style={{ marginTop: 12 }}>
              {!run.answers[k] ? "Not answered yet." : run.rule_true[k] ? <><span className="key-dot sem" /> <b>Rule met:</b> this hour alerts.</> : "Rule not met."}
            </p>
          )}
          <p className="read-text"><span className="muted">What the model {run ? "read" : "would read"}: </span>{run ? run.prose[k] : snapshot(d, i)}</p>
        </div>
        <div>
          {run && tree
            ? <Answers questions={run.compiled.questions} answers={run.answers[k]} tree={tree} />
            : <p className="muted small">Run an alert to see the model's answers for each hour. Hover over the charts to move through the week.</p>}
        </div>
      </div>
    </section>
  );
}

function Explorer({ d }: { d: Hourly }) {
  const [start, setStart] = useState(() => weekOf(d, new URLSearchParams(location.search).get("week") ?? d.weeks[0].start).start);
  const week = useMemo(() => weekOf(d, start), [d, start]);
  const suggested = d.weeks.find((w) => w.start === week.start);
  const [sentence, setSentence] = useState(() => suggested?.example ?? d.weeks[0].example);
  const [key, setKey] = useState(() => { try { return sessionStorage.getItem("openai-key") ?? ""; } catch { return ""; } });
  const [saved, setSaved] = useState<Record<string, WeekRun | null>>({});
  const [live, setLive] = useState<WeekRun[]>([]);
  const [progress, setProgress] = useState<{ run: WeekRun | null; text: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(false);
  const compiled = useRef(new Map<string, Compiled>());
  const abort = useRef<AbortController | null>(null);
  const sq = sentence.trim();
  const examples = new Set(d.weeks.map((w) => w.example));

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

  const shown = useMemo<Shown | null>(() => {
    if (progress?.run && progress.run.week === week.start) return { run: progress.run, source: "live", stale: false };
    const mine = live.filter((r) => r.week === week.start).reverse();
    const exact = mine.find((r) => r.sentence === sq);
    if (exact) return { run: exact, source: "live", stale: false };
    const sv = saved[week.start];
    if (sv && sv.sentence === sq) return { run: sv, source: "saved", stale: false };
    if (mine[0]) return { run: mine[0], source: "live", stale: true };
    return sv ? { run: sv, source: "saved", stale: true } : null;
  }, [progress, live, saved, week.start, sq]);

  const pickWeek = (s: string, example?: string) => {
    setStart(weekOf(d, s).start);
    if (example && (!sq || examples.has(sq))) setSentence(example);
  };

  async function run() {
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
    setProgress({ run: null, text: known ? "Answering each hour" : "Compiling the alert", done: 0, total });
    try {
      const result = await runWeek({ key: k, signal: ctl.signal }, d, week.start, sq, {
        compiled: known,
        onProgress: (p) => setProgress(p.phase === "compiling"
          ? { run: null, text: `Compiling the alert${p.attempt > 1 ? `, attempt ${p.attempt} of 3` : ""}`, done: 0, total }
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
  const running = progress !== null;
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Try it · your key, your alert, any week</p>
        <h1>Run your own sentence alert</h1>
        <p className="lede">
          Pick a week of ERCOT data, write an alert as a sentence, and run it with your OpenAI key. gpt-6-luna turns the
          sentence into questions once; the Decisions API answers them for every hour of the week; plain code decides
          which hours alert.
        </p>
      </section>

      <div className="steps">
        <div>
          <div className="step-head"><span className="n">1</span><h2>Pick a week</h2></div>
          <div className="chips" role="group" aria-label="Suggested weeks">
            {d.weeks.map((w) => (
              <button key={w.start} type="button" className="chip" aria-pressed={w.start === week.start} onClick={() => pickWeek(w.start, w.example)}>
                {w.title}<span>{weekLabel(weekOf(d, w.start)).replace(/, \d{4}$/, "")}</span>
              </button>
            ))}
          </div>
          <Calendar d={d} week={week} onPick={(s) => pickWeek(s)} />
          <div className="week-bar">
            <span className="label">{weekLabel(week)}</span>
            <button type="button" className="icon-btn" aria-label="Previous week" disabled={week.start === d.days[0].date}
              onClick={() => pickWeek(addDays(week.start, -7))}>‹</button>
            <button type="button" className="icon-btn" aria-label="Next week" disabled={week.start === lastStart(d)}
              onClick={() => pickWeek(addDays(week.start, 7))}>›</button>
          </div>
          {suggested && <p className="week-note">{suggested.note}</p>}
          {unusual.length > 0
            ? <ul className="unusual">{unusual.map((x) => <li key={x.date}><b>{shortDay(x.date)}</b>{x.tags.map((t) => t.text).join(" · ")}</li>)}</ul>
            : <p className="week-note">Nothing unusual this week by these measures, which makes it a good test of whether an alert stays quiet.</p>}
        </div>

        <div>
          <div className="step-head"><span className="n">2</span><h2>Write the alert</h2></div>
          <textarea className="field" rows={2} value={sentence} maxLength={300} onChange={(e) => setSentence(e.target.value)}
            aria-label="Your alert, as one sentence" placeholder="Tell me when…" />
          <p className="hint">
            The model reads one hour at a time: demand, solar, wind, batteries, prices and reserves, nothing else.{" "}
            <button type="button" onClick={() => setSample(!sample)} aria-expanded={sample}>{sample ? "Hide the example" : "See an example hour"}</button>
          </p>
          {sample && <p className="sample">{snapshot(d, week.from + 20)}</p>}
        </div>

        <div>
          <div className="step-head"><span className="n">3</span><h2>Run it</h2></div>
          <div className="run-row">
            <input className="field" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Your OpenAI API key (sk-…)"
              aria-label="Your OpenAI API key" autoComplete="off" spellCheck={false} />
            {running
              ? <button type="button" className="btn ghost" onClick={() => abort.current?.abort()}>Stop</button>
              : <button type="button" className="btn" disabled={!key.trim() || sq.length < 8} onClick={run}>Run on {hours} hours</button>}
          </div>
          <p className="hint">
            The key stays in this browser tab and is sent only to api.openai.com. A run makes a few short calls to compile the
            sentence, then {hours} Decisions API calls: about {Math.round((hours * TOKENS_PER_HOUR) / 1000)},000 input tokens,
            roughly ${((hours * TOKENS_PER_HOUR) / 1e6 * USD_PER_M_INPUT).toFixed(3)} at ${USD_PER_M_INPUT.toFixed(2)} per million.
            {compiled.current.has(sq) ? " This sentence is already compiled, so the run reuses it." : ""}
          </p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>

      <Results d={d} week={week} shown={shown} progress={progress} />
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
    <Shell page="try" footer={
      <>
        <p>Hourly data from the Grid Status API{d ? ` (${d.datasets.join(", ")})` : ""}, {d ? `${dayLabel(d.range.first_day, { month: "short", day: "numeric", year: "numeric" })} to ${dayLabel(d.range.last_day, { month: "short", day: "numeric", year: "numeric" })}` : ""}. Times are US Central.</p>
        <p>Your runs call OpenAI's gpt-6-luna from this page with your key: the Responses API compiles the sentence, the Decisions API answers each hour. Nothing is stored on a server.</p>
      </>
    }>
      {err && <p className="bad hero">Couldn't load the data: {err}</p>}
      {!d && !err && <p className="muted hero">Loading ten months of ERCOT data…</p>}
      {d && <Explorer d={d} />}
    </Shell>
  );
}
