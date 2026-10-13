// The demo that plays in the empty space beside "How should you be notified?": a play button, then a
// short narrated walk-through advanced with one arrow. A step can point at part of the form (its spot).

import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { Icon } from "./ui";
import "./demo.css";

/** What a step points at in the form: "rule" rings the series row; "fill" also fills the form in with
 *  one threshold alert after another (FILLS), as a researcher would; "prompt" turns the row into a single
 *  description field that types out PROMPTS; "snapshot" keeps that field on the abnormality prompt and
 *  swaps the notification settings for a timeline of five-minute snapshots; "pull" swaps them for the
 *  week pulled from Grid Status to run the test on; "judge" for the model's verdict on each hour of it;
 *  "notify" for the notifications and digest the model wrote from the abnormal hours; "cost" and "value" for
 *  the close: a year's cost at each cadence, and what it unlocks. */
export type Spot = "rule" | "fill" | "prompt" | "snapshot" | "pull" | "judge" | "notify" | "cost" | "value";

/** Fuzzy alerts different customers might describe, typed out in turn on the "prompt" step. */
const PROMPTS = [
  { who: "Researcher", text: "Tell me whenever ERCOT is doing something unusual" },
  { who: "Demand response", text: "Reserves are tight enough that we should curtail load" },
  { who: "Trader", text: "This price spike looks like more than a passing blip" },
  { who: "Battery operator", text: "Solar is falling off faster than the evening forecast expects" },
];

/** The alerts the form fills in with on the "fill" step, in turn. */
export const FILLS = [
  { series: "ERCOT · Hub price ($/MWh)", op: "Greater than or equal to", value: "1000" },
  { series: "ERCOT · Reserves, PRC (MW)", op: "Less than", value: "3000" },
  { series: "ERCOT · Load (MW)", op: "Greater than or equal to", value: "85000" },
  { series: "ERCOT · Wind generation (MW)", op: "Less than", value: "2000" },
  { series: "ERCOT · Non-spin price ($/MWh)", op: "Greater than or equal to", value: "500" },
  { series: "ERCOT · Frequency (Hz)", op: "Less than", value: "59.9" },
];

/** Narration with emphasized phrases: "rule" is underlined with a straight line, like a threshold;
 *  "noise" with a jagged one, like grid data; "narrow" with a line that draws out, then shrinks; "fuzzy"
 *  with a soft, blurred glow, like a degree of truth; "snap" with a yellow highlight, like the snapshots;
 *  "hot" with an orange one, the color of the hours judged abnormal; "code" sets a literal answer in monospace. */
type Seg = string | { text: string; mark: "rule" | "noise" | "narrow" | "fuzzy" | "snap" | "hot" | "code" };

/** A step of narration. visual "rules" adds an endless drift of threshold rules under the text. */
interface Step { eyebrow: string; title: Seg[]; body: Seg[]; spot?: Spot; visual?: "rules" }

const STEPS: Step[] = [
  {
    eyebrow: "Alerts today",
    title: ["Today, every alert is a ", { text: "hard-coded rule", mark: "rule" }, "."],
    body: [
      "You pick a series, a comparison and a number, and every new row either passes or it doesn’t. That’s fine for a clean threshold, but it may not capture what a customer actually wants to know, especially on data as ",
      { text: "messy and volatile", mark: "noise" },
      " as the US electric grid.",
    ],
    spot: "rule",
  },
  {
    eyebrow: "Where rules break",
    title: ["Some questions don’t fit in a rule."],
    body: [
      "Say a researcher wants to know whenever ERCOT does something unusual. That takes an open-ended list of conditions, and each one only catches the exact case it spells out. The more precise the rules, the ",
      { text: "narrower", mark: "narrow" },
      " the net, so no stack of thresholds can flag ",
      { text: "every anomaly", mark: "noise" },
      " on the grid.",
    ],
    visual: "rules",
  },
  {
    eyebrow: "One rule, one alert",
    title: ["So the researcher writes ", { text: "another rule", mark: "rule" }, ". And another."],
    body: [
      "Every condition becomes its own alert, filled in on this form one at a time. Each watches a single number in isolation, so none of them can tell when reserves are sliding, prices are climbing and the wind is dropping out ",
      { text: "all at once", mark: "noise" },
      ", which is exactly the moment worth knowing about.",
    ],
    spot: "fill",
  },
  {
    eyebrow: "A different kind of alert",
    title: ["What if an alert could make a ", { text: "judgment call", mark: "fuzzy" }, "?"],
    body: [
      "Think of how an experienced grid operator glances at a screen and just knows something’s off. A System 1 model works the same way. Ask it a question about each new row and it gives back a ",
      { text: "probability", mark: "fuzzy" },
      " in a fraction of a second, for a fraction of a cent. So the alert doesn’t need a series, a comparison and a number anymore. You just describe what you’re looking for.",
    ],
    spot: "prompt",
  },
  {
    eyebrow: "How it works",
    title: ["Picture an ERCOT abnormality alert."],
    body: [
      { text: "Every five minutes", mark: "snap" },
      ", a snapshot of the grid (prices, load, reserves, wind, solar and weather) goes to a System 1 model with a finite set of answers: ",
      { text: "abnormal", mark: "code" },
      " or ",
      { text: "not_abnormal", mark: "code" },
      ". The model weighs everything at once and decides holistically, with no thresholds to write.",
    ],
    spot: "snapshot",
  },
  {
    eyebrow: "Run the test",
    title: ["Let’s run it on a real week."],
    body: [
      "I pulled seven days of ERCOT data from the Grid Status API: August 20 to 26, 2026, the middle of a heat wave. Ordinary threshold alerts on price, reserves and demand would have fired 13 times that week. But a threshold firing doesn’t mean something was abnormal, so I checked each one against the month before. Only ",
      { text: "6 went past anything in it", mark: "hot" },
      ": record prices and record-low reserves. The other 7, mostly demand above 90 GW, had already been topped that month. Hover a day to see which.",
    ],
    spot: "pull",
  },
  {
    eyebrow: "The judgment",
    title: ["The model read all 168 hours."],
    body: [
      "Each hourly snapshot went to gpt-6-luna with the same question and the same two answers, at a median of 131 milliseconds an hour and well under a cent for the week. It caught ",
      { text: "all 6", mark: "hot" },
      ", every record price and reserve reading, each at 99%, and stayed quiet through the 90 GW afternoons. It also raised 6 flags of its own: five evenings when reserves fell 4 to 6 GW within an hour as the sun went down, and one early-morning dip. None set a record. Those are judgment calls, and the cutoff is how you’d tune them.",
    ],
    spot: "judge",
  },
  {
    eyebrow: "Write it up",
    title: ["Then a language model writes the alert."],
    body: [
      "The hours it flagged, grouped into 9 episodes, went back to gpt-6-luna, which wrote each one up as a notification using only the numbers in its snapshots, then turned those into a digest of the week. A fast judgment decides ",
      { text: "when to speak", mark: "fuzzy" },
      "; a language model decides what to say.",
    ],
    spot: "notify",
  },
  {
    eyebrow: "The cost",
    title: ["Always on, for pocket change."],
    body: [
      "Every number comes from the test run. Nearly all the cost is the judging: one Decisions API call per snapshot, about 374 input tokens at $0.10 per million, with no output to pay for. The write-ups through the Responses API add pennies: run on every hour since December, the alert fired 187 times in 308 days, about 222 notifications a year. Judging every five minutes, around the clock, and writing up every one of those, comes to ",
      { text: "about $4 a year", mark: "hot" },
      " per alert. Every minute is under $20.",
    ],
    spot: "cost",
  },
  {
    eyebrow: "Why it matters",
    title: ["Alerts that understand the grid."],
    body: [
      "Grid Status already has the data people trust. A System 1 layer lets them ask it questions in their own words, and get back a judgment in milliseconds, for a fraction of a cent, structured enough to test and audit. One sentence replaces a stack of thresholds, and every notification explains itself. It’s the kind of product I’d love to ",
      { text: "build at Grid Status", mark: "fuzzy" },
      ".",
    ],
    spot: "value",
  },
];

/** The abnormality alert the "snapshot" step describes. */
const ABNORMAL = "Tell me whenever ERCOT is doing something abnormal";

// The threshold alerts a researcher would have to keep adding, two rows drifting in opposite directions.
const RULES: [string, string, string][][] = [
  [["Hub price", "≥", "$1,000/MWh"], ["Reserves", "<", "3,000 MW"], ["Load", "≥", "85,000 MW"], ["Wind", "<", "2,000 MW"], ["Non-spin price", "≥", "$500/MWh"], ["Frequency", "<", "59.9 Hz"]],
  [["Net load", "≥", "70,000 MW"], ["Hub price", "<", "−$20/MWh"], ["Solar", "<", "1,000 MW"], ["Temperature", "≥", "105°F"], ["Load vs. forecast", "≥", "+5%"], ["Storage discharge", "≥", "8,000 MW"]],
];
const BELL = ["M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6", "M9 17v1a3 3 0 0 0 6 0v-1"];

// Timing, in ms: words arrive one after another, the title's then the body's; the arrow comes last.
const TITLE_AT = 250, TITLE_STAGGER = 45, BODY_GAP = 220, BODY_STAGGER = 22, ARROW_GAP = 350;
const EXIT_MS = 380;

const tokens = (s: string) => s.split(/(\s+)/).filter(Boolean);
const isSpace = (t: string) => /^\s+$/.test(t);
const words = (segs: Seg[]) => segs.reduce((n, s) => n + tokens(typeof s === "string" ? s : s.text).filter((t) => !isSpace(t)).length, 0);
const plain = (segs: Seg[]) => segs.map((s) => (typeof s === "string" ? s : s.text)).join("");

const bodyAt = (s: Step) => TITLE_AT + words(s.title) * TITLE_STAGGER + BODY_GAP;
const arrowAt = (s: Step) => bodyAt(s) + words(s.body) * BODY_STAGGER + ARROW_GAP;
const spotAt = (s: Step) => TITLE_AT + words(s.title) * TITLE_STAGGER + 700; // once the title's underline is drawn

/** Text whose words fade in one after another, with any marked phrase underlined once its words are in. */
function Reveal({ segs, at, stagger }: { segs: Seg[]; at: number; stagger: number }) {
  let i = 0;
  const run = (text: string, key: string) => tokens(text).map((t, k) =>
    isSpace(t) ? t : <span key={`${key}.${k}`} className="w" style={{ animationDelay: `${at + i++ * stagger}ms` }}>{t}</span>);
  return (
    <>
      {segs.map((s, j) => {
        if (typeof s === "string") return <Fragment key={j}>{run(s, `${j}`)}</Fragment>;
        const inner = run(s.text, `${j}`);
        return (
          <span key={j} className={`mark ${s.mark}`} style={{ "--d": `${at + i * stagger + 150}ms` } as CSSProperties}>
            {inner}
            {s.mark === "noise" && (
              <svg className="squiggle" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 5L5 3.5L9 6L14 2.5L18 5L23 4L27 7L32 2L36 5.5L41 3L45 6.5L50 1.5L54 5L59 3.5L63 7L68 2.5L72 5L77 3L81 6.5L86 2L90 5L95 3.5L100 5" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </span>
        );
      })}
    </>
  );
}

/** Rule chips drifting past in two rows, each row its chips twice over so the loop is seamless. */
function Rules({ at }: { at: number }) {
  return (
    <div className="rules" style={{ "--at": `${at}ms` } as CSSProperties} aria-hidden="true">
      {RULES.map((row, r) => (
        <div key={r} className="rules-row">
          <div className="rules-track">
            {[...row, ...row].map(([series, op, value], k) => (
              <span key={k} className="rule-chip"><Icon d={BELL} size={13} stroke={1.75} />{series}<i>{op}</i><b>{value}</b></span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The ring a step puts around part of the form; it fades out rather than vanishing when the step moves on,
 *  keeping its last label. The label animates in each time it changes. */
export function SpotRing({ on, label }: { on: boolean; label: string }) {
  const [shown, setShown] = useState(on);
  const [last, setLast] = useState(label);
  useEffect(() => { if (on) setLast(label); }, [on, label]);
  useEffect(() => {
    if (on) { setShown(true); return; }
    const t = setTimeout(() => setShown(false), 300);
    return () => clearTimeout(t);
  }, [on]);
  if (!on && !shown) return null;
  const text = on ? label : last;
  return <span className={`spot-ring${on ? "" : " out"}`} aria-hidden="true"><span key={text} className="spot-tag">{text}</span></span>;
}

/** Types out each prompt, holds it, erases it, and moves to the next, for as long as it's shown. */
function useTypewriter(active: boolean) {
  const [state, setState] = useState({ k: 0, len: 0 });
  useEffect(() => {
    if (!active) { setState({ k: 0, len: 0 }); return; }
    let k = 0, len = 0, typing = true, t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const full = PROMPTS[k].text.length;
      if (typing && len < full) { len++; t = setTimeout(tick, 34); }
      else if (typing) { typing = false; t = setTimeout(tick, 2200); }
      else if (len > 0) { len--; t = setTimeout(tick, 14); }
      else { typing = true; k = (k + 1) % PROMPTS.length; t = setTimeout(tick, 350); }
      setState({ k, len });
    };
    t = setTimeout(tick, 500);
    return () => clearTimeout(t);
  }, [active]);
  return { ...PROMPTS[state.k], typed: PROMPTS[state.k].text.slice(0, state.len) };
}

/** The "Describe it" field the series row turns into: one prompt instead of a series, a comparison and a number. */
export function PromptRow({ active, fixed = false }: { active: boolean; fixed?: boolean }) {
  const cycle = useTypewriter(active && !fixed);
  return (
    <div className="prompt-row" aria-hidden={!active}>
      <span className="label">Describe it <span className="new">New</span></span>
      <div className="input prompt-field">
        <Icon d={SPARKLES} size={18} stroke={1.75} />
        {fixed ? (
          <>
            <span key="fixed" className="typed settled">{ABNORMAL}</span>
            <span className="answers"><code>abnormal</code><code>not_abnormal</code></span>
          </>
        ) : (
          <>
            <span className="typed">{cycle.typed}<i className="caret" /></span>
            <span key={cycle.who} className="who">{cycle.who}</span>
          </>
        )}
      </div>
    </div>
  );
}
const SPARKLES = ["M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"];

function StepView({ step, n, leaving }: { step: Step; n: number; leaving: boolean }) {
  return (
    <div className={`step${leaving ? " leaving" : ""}`} aria-live="polite">
      <p className="eyebrow"><span>{String(n + 1).padStart(2, "0")}</span><i aria-hidden="true" />{step.eyebrow}</p>
      <h3 className="step-title">
        <span className="sr">{plain(step.title)}</span>
        <span aria-hidden="true"><Reveal segs={step.title} at={TITLE_AT} stagger={TITLE_STAGGER} /></span>
      </h3>
      <p className="step-body">
        <span className="sr">{plain(step.body)}</span>
        <span aria-hidden="true"><Reveal segs={step.body} at={bodyAt(step)} stagger={BODY_STAGGER} /></span>
      </p>
      {step.visual === "rules" && <Rules at={arrowAt(step) - ARROW_GAP} />}
    </div>
  );
}

export default function Demo({ onSpot }: { onSpot: (spot: Spot | null) => void }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "running">("idle");
  const [i, setI] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  // Point at the form once the step's title has landed.
  useEffect(() => {
    if (phase !== "running" || leaving || !step.spot) return;
    const t = setTimeout(() => onSpot(step.spot ?? null), spotAt(step));
    return () => clearTimeout(t);
  }, [phase, leaving, step, onSpot]);

  const start = () => {
    setPhase("starting");
    setTimeout(() => setPhase("running"), EXIT_MS);
  };
  const next = () => {
    if (leaving) return;
    if (last) return replay();
    setLeaving(true);
    // A step with its own spot takes over from the last one when its title lands; otherwise clear it now.
    if (!STEPS[i + 1].spot) onSpot(null);
    setTimeout(() => { setI(i + 1); setLeaving(false); }, EXIT_MS);
  };

  // From the last step, the arrow starts over: back to the play button, with the form as it began.
  function replay() {
    setLeaving(true);
    onSpot(null);
    setTimeout(() => { setI(0); setLeaving(false); setPhase("idle"); }, EXIT_MS);
  }

  return (
    <section className="stage" aria-label="Demo">
      {phase !== "running" ? (
        <div className={`intro${phase === "starting" ? " out" : ""}`}>
          <button type="button" className="play" onClick={start} disabled={phase === "starting"} aria-label="Begin the demo">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M7 4.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L8.52 3.75A1 1 0 0 0 7 4.6z" fill="currentColor" /></svg>
          </button>
          <p className="intro-label">Press here to begin the demo</p>
          <p className="intro-hint">Then use the arrow to step through</p>
        </div>
      ) : (
        <>
          <StepView key={i} step={step} n={i} leaving={leaving} />
          <button key={`next-${i}`} type="button" className={`next${leaving ? " away" : ""}${last ? " replay" : ""}`} onClick={next} aria-label={last ? "Replay the demo" : "Next"}
            style={{ "--in": `${arrowAt(step)}ms` } as CSSProperties}>
            <Icon d={last ? ["M19.95 11a8 8 0 1 0 -.5 4", "M20 20v-5h-5"] : ["M5 12h14", "M13 18l6-6", "M13 6l6 6"]} size={20} />
          </button>
        </>
      )}
    </section>
  );
}
