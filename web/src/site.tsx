// Pieces both pages share: the header (navigation, theme), the footer, number formats, and the
// model's answers with the rule's conditions marked met or not.

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

export function Shell({ page, children, footer }: { page: "story" | "try"; children: ReactNode; footer?: ReactNode }) {
  const [theme, nextTheme] = useTheme();
  const label = theme === "system" ? "Theme: automatic" : theme === "light" ? "Theme: light" : "Theme: dark";
  return (
    <div className="page">
      <header className="site">
        <a className="brand" href={BASE}>Sentence alerts <span>for ERCOT</span></a>
        <nav aria-label="Pages">
          <a href={BASE} aria-current={page === "story" ? "page" : undefined}>July 22</a>
          <a href={`${BASE}try/`} aria-current={page === "try" ? "page" : undefined}>Try it</a>
        </nav>
        <button type="button" className="theme-btn" onClick={nextTheme} aria-label={`${label}. Switch theme`} title={label}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{THEME_ICON[theme]}</svg>
        </button>
      </header>
      <main>{children}</main>
      <footer className="foot">
        {footer}
        <p>An independent concept demo. Not affiliated with Grid Status.</p>
      </footer>
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
