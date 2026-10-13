// Grid Status's Create Alert form, drawn to match alerts_ui.png, inside the app frame. The form is the look
// only: nothing in it is wired up. The demo plays in the .demo cell beside "How should you be notified?",
// and can spotlight parts of the form as it goes.

import { useEffect, useState, type ReactNode } from "react";
import AppShell from "./AppShell";
import Demo, { FILLS, PromptRow, SpotRing, type Spot } from "./Demo";
import Snapshots from "./Snapshots";
import WeekPull from "./WeekPull";
import Results from "./Results";
import Wrap from "./Wrap";
import { EMAIL, Icon } from "./ui";

/** A form section: a title, a line of help, then the controls. */
function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2 className="title">{title}</h2>
      {help && <p className="help">{help}</p>}
      {children}
    </section>
  );
}

/** A number box with up and down chevrons, like Value and Notification Timeout. */
function NumberBox({ id, placeholder, disabled, className = "", children }: {
  id: string; placeholder?: string; disabled?: boolean; className?: string; children?: ReactNode;
}) {
  return (
    <div className={`number ${className}`} data-disabled={disabled || undefined}>
      <input id={id} type="number" placeholder={placeholder} disabled={disabled} />
      {children}
      <span className="steps" aria-hidden="true"><Chevron up /><Chevron /></span>
    </div>
  );
}

function Switch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button type="button" className="switch" role="switch" aria-checked="true" aria-label={label}>
      <span className="track" aria-hidden="true" />
      {children}
    </button>
  );
}

/** Text the demo fills a field in with, drawn over the field so it can animate in. */
const Fill = ({ delay = 0, children }: { delay?: number; children: ReactNode }) => (
  <span className="fill-text" style={{ animationDelay: `${delay}ms` }}>{children}</span>
);

const FILL_MS = 1700; // how long each alert stays filled in before the next

const ChartIcon = () => <Icon d={["M4 19h16", "M4 15l4-6 4 2 4-5 4 4"]} />;
const SelectorIcon = () => <Icon size={16} d={["M8 9l4-4 4 4", "M16 15l-4 4-4-4"]} />;
const MailIcon = () => <Icon d={["M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z", "M3 7l9 6 9-6"]} />;
const InfoIcon = () => <Icon size={20} d={["M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0", "M12 9h.01", "M11 12h1v4h1"]} />;
const Chevron = ({ up = false }: { up?: boolean }) => (
  <svg width="9" height="5" viewBox="0 0 9 5" aria-hidden="true">
    <path d={up ? "M1 4l3.5-3 3.5 3" : "M1 1l3.5 3 3.5-3"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function AlertForm() {
  const [spot, setSpot] = useState<Spot | null>(null);
  // On the "fill" step, count up through alert after alert; the form shows FILLS in turn.
  const [n, setN] = useState(0);
  useEffect(() => {
    if (spot !== "fill") { setN(0); return; }
    setN(1);
    const t = setInterval(() => setN((k) => k + 1), FILL_MS);
    return () => clearInterval(t);
  }, [spot]);
  const fill = n > 0 ? FILLS[(n - 1) % FILLS.length] : null;
  // From the snapshot step on, the alert is the abnormality prompt and the notification settings make way
  // for the demo's timelines.
  const later = spot === "snapshot" || spot === "pull" || spot === "judge" || spot === "notify" || spot === "cost" || spot === "value";
  return (
    <AppShell section="Alerts" page="New Alert">
      <form className="card" onSubmit={(e) => e.preventDefault()}>
        <Section title="Name your alert" help="You will see this name when receiving notifications">
          <div className="name-box">
            <input className={`input name${fill ? " hush" : ""}`} defaultValue="New Alert" aria-label="Alert name" />
            {fill && <Fill key={n}>Anomaly watch #{n}</Fill>}
          </div>
        </Section>

        <Section title="What would you like to monitor?" help="The alert will be triggered if the condition is met for any new row in the dataset since the last time the alert was run.">
          <div className={`monitor${spot === "prompt" || later ? " prompting" : ""}`}>
          <div className={`series-row${fill ? " filled" : ""}`}>
            <div className="field">
              <label className="label" htmlFor="series">Select Series</label>
              <button id="series" type="button" className="input picker">
                {fill ? <Fill key={n} delay={120}>{fill.series}</Fill> : <span>Select data</span>}
                <span className="right"><ChartIcon /></span>
              </button>
            </div>
            <div className="field">
              <label className="label" htmlFor="op">Is</label>
              <div className="select">
                <input id="op" className="input" placeholder={fill ? "" : "Greater than or equal to"} disabled />
                {fill && <Fill key={n} delay={240}>{fill.op}</Fill>}
                <span className="right"><SelectorIcon /></span>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="value">Value</label>
              <NumberBox id="value" disabled>{fill && <Fill key={n} delay={360}>{fill.value}</Fill>}</NumberBox>
            </div>
          </div>
          <PromptRow active={spot === "prompt" || later} fixed={later} />
          <SpotRing on={spot === "rule" || spot === "fill" || spot === "prompt"} label={spot === "fill" ? `Alert ${Math.max(n, 1)}` : spot === "prompt" ? "Just describe it" : "Hard-coded rule"} />
          </div>
        </Section>

        <div className={`lower${later ? " zoomed" : ""}`}>
          <Snapshots active={spot === "snapshot"} />
          <WeekPull active={spot === "pull"} />
          <Results mode={spot === "judge" || spot === "notify" ? spot : null} />
          <Wrap mode={spot === "cost" || spot === "value" ? spot : null} />
          <div className="lower-head">
            <h2 className="title">How should you be notified?</h2>
            <p className="help">When the alert is enabled, notifications will be sent via these methods. Notifications can only be sent to the primary email address and/or phone number on your account.</p>
          </div>

          <div className="lower-form">
            <div className="methods">
              <div className="method">
                <div>
                  <div className="method-name"><MailIcon />Email</div>
                  <div className="method-addr">{EMAIL}</div>
                </div>
                <Switch label="Email notifications">On</Switch>
              </div>
              <div className="callout">
                <span className="callout-icon"><InfoIcon /></span>
                <p>Want to receive notifications via SMS? <a className="link">Upgrade</a> to enable SMS alerts.</p>
              </div>
            </div>

            <Section title="Notification Timeout" help="After the alert is triggered, how long should we wait before sending another notification?">
              <NumberBox id="timeout" className="timeout" placeholder="No timeout" />
            </Section>

            <Section title="Alert Status">
              <Switch label="Alert status">Enabled</Switch>
            </Section>

            <button key={n} type="submit" className={`btn${fill ? " armed" : ""}`} disabled>Create</button>
          </div>

          <div className="demo"><Demo onSpot={setSpot} /></div>
        </div>
      </form>
    </AppShell>
  );
}
