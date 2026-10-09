// Pieces both pages share: the app frame (navigation, theme, footer), form controls modeled on Grid
// Status's alert form, number formats, and the model's answers with the rule's conditions marked.

import { useEffect, useState, type ReactNode } from "react";
import { describeLeaf, evaluate, leaves, type Node } from "./rule";
import type { AnswerJSON, Question } from "./types";

export const BASE = import.meta.env.BASE_URL;

export const gw = (mw: number) => `${(mw / 1000).toFixed(1)} GW`;
export const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const orNA = (v: number | null | undefined, f: (x: number) => string) => (v === null || v === undefined ? "n/a" : f(v));

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem("theme") as Theme) || "system"; } catch { return "system"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))];
}

const THEME_ICON: Record<Theme, ReactNode> = {
  system: <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5v9a4.5 4.5 0 0 1 0-9Z" fill="currentColor" />,
  light: <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></g>,
  dark: <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
};

export function Shell({ page, children, footer }: { page: "overview" | "create"; children: ReactNode; footer?: ReactNode }) {
  const [theme, nextTheme] = useTheme();
  const label = theme === "system" ? "Theme: automatic" : theme === "light" ? "Theme: light" : "Theme: dark";
  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <a className="brand" href={BASE}>Sentence alerts</a>
          <span className="pill">Concept · proposed enhancement</span>
          <nav aria-label="Pages">
            <a href={BASE} aria-current={page === "overview" ? "page" : undefined}>Overview</a>
            <a href={`${BASE}try/`} aria-current={page === "create" ? "page" : undefined}>Create alert</a>
          </nav>
          <button type="button" className="theme-btn" onClick={nextTheme} aria-label={`${label}. Switch theme`} title={label}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{THEME_ICON[theme]}</svg>
          </button>
        </div>
      </header>
      <main className="wrap">{children}</main>
      <footer className="foot">
        {footer}
        <p>An independent concept demo for a proposed alerts feature. Not affiliated with or endorsed by Grid Status.</p>
      </footer>
    </>
  );
}

/** A form section, as in the alert form: a title, a line of help, then the controls. */
export function Section({ title, help, badge, id, children }: { title: ReactNode; help?: ReactNode; badge?: string; id?: string; children: ReactNode }) {
  return (
    <section className="section" id={id}>
      <h2 className="section-title">{title}{badge && <span className="badge">{badge}</span>}</h2>
      {help && <p className="section-help">{help}</p>}
      {children}
    </section>
  );
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`field ${className}`}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <select className="select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** A number box with a stepper, like the form's Value and Notification Timeout. null means empty. */
export function NumberInput({ value, onChange, step = 1, min, placeholder, unit, label, className = "" }: {
  value: number | null; onChange: (v: number | null) => void; step?: number; min?: number;
  placeholder?: string; unit?: string; label: string; className?: string;
}) {
  const bump = (dir: 1 | -1) => {
    const next = (value ?? 0) + dir * step;
    onChange(min !== undefined ? Math.max(min, next) : next);
  };
  return (
    <div className={`number ${className}`}>
      <input type="number" inputMode="decimal" value={value ?? ""} placeholder={placeholder} aria-label={label} step={step} min={min}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      {unit && value !== null && <span className="unit">{unit}</span>}
      <span className="steps">
        <button type="button" aria-label={`Increase ${label}`} onClick={() => bump(1)}><Chevron up /></button>
        <button type="button" aria-label={`Decrease ${label}`} onClick={() => bump(-1)}><Chevron /></button>
      </span>
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="track" aria-hidden="true" />
      {label}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="callout">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10 9v5M10 6.2v.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
      <div>{children}</div>
    </div>
  );
}

export const MailIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3 5.5l7 5.5 7-5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
);

export const ChartIcon = () => (
  <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true"><path d="M1 12l5-6 4 3 5-6 6 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /><path d="M1 15h20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

function Chevron({ up = false }: { up?: boolean }) {
  return <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d={up ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** One alert's side of a moment, under the charts: what it sent, then why. Threshold left, description right. */
export function AlertCol({ tone, children }: { tone: "sem" | "thr"; children: ReactNode }) {
  return (
    <div className="alert-col">
      <div className="alert-col-head"><span className={`key-dot ${tone}`} />{tone === "thr" ? "Threshold" : "Describe it"}</div>
      {children}
    </div>
  );
}

/** What an alert did at this moment when it sent nothing. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="quiet">{children}</p>;
}

/** The threshold's check at one moment, laid out like the model's answers: the value, then the condition met or not. */
export function ThresholdCheck({ label, value, met, needs }: { label: ReactNode; value: string; met: boolean; needs: string }) {
  return (
    <div className="answers">
      <div>
        <div className="q">{label}</div>
        <div className="check-val">{value}</div>
        <div className="conds"><span className={met ? "met" : ""}>{met ? "✓" : "✗"} needs {needs}</span></div>
      </div>
    </div>
  );
}

/** A notification as the recipient would see it. */
export function Mail({ tone, name, when, children }: { tone: "sem" | "thr"; name: string; when: string; children: ReactNode }) {
  return (
    <div className={`mail ${tone}`}>
      <div className="mail-head"><MailIcon /><b>{name}</b><span className="muted">{when}</span></div>
      <div className="mail-body">{children}</div>
    </div>
  );
}

/** The model's answers to each question, with every condition the rule puts on it marked met or not. */
export function Answers({ questions, answers, tree }: { questions: Question[]; answers: Record<string, AnswerJSON> | null; tree: Node | null }) {
  return (
    <div className="answers">
      {questions.map((q) => {
        const a = answers?.[q.id];
        const conds = tree ? leaves(tree).filter((c) => c.qid === q.id) : [];
        return (
          <div key={q.id}>
            <div className="q">{q.text}</div>
            {!a ? <div className="bar-row"><span>Waiting for an answer…</span></div>
              : a.refused ? <div className="bar-row"><span>The model declined to answer.</span></div>
              : <Bars q={q} a={a} />}
            {a && conds.length > 0 && (
              <div className="conds">
                {conds.map((c, k) => {
                  const met = evaluate(c, { [q.id]: a }, questions);
                  return <span key={k} className={met ? "met" : ""}>{met ? "✓" : "✗"} needs {describeLeaf(c, q)}</span>;
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bars({ q, a }: { q: Question; a: AnswerJSON }) {
  const opts = q.kind === "probability" ? ["yes"] : q.options;
  const top = Object.entries(a.probs).reduce((b, c) => (c[1] > b[1] ? c : b))[0];
  return (
    <>
      {opts.map((o) => {
        const p = a.probs[o] ?? 0;
        return (
          <div key={o} className={`bar-row${q.kind === "probability" || o === top ? " top" : ""}`}>
            <span>{q.kind === "probability" ? "Yes" : o}</span>
            <span className="bar"><i style={{ width: `${Math.max(p * 100, 1)}%` }} /></span>
            <span className="bar-val">{pct(p)}</span>
          </div>
        );
      })}
      {q.kind === "score" && a.expected !== undefined && (
        <div className="bar-row top"><span>Weighted level</span><span /><span className="bar-val">{a.expected.toFixed(2)}</span></div>
      )}
    </>
  );
}
