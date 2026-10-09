// The whole date range as a calendar: one column per week, one row per weekday. Each day is shaded by
// how many unusual signals it had (pipeline/08_range_state.py), so the interesting weeks stand out.
// Clicking a day starts the week there; arrow keys move it. Hovering or focusing a day shows what
// happened in a tooltip, so the page below doesn't move.

import { useEffect, useRef, useState } from "react";
import { addDays, dayLabel, type Hourly, type Week } from "./data";

const ROW_LABEL = ["", "Mon", "", "Wed", "", "Fri", ""];

export function Calendar({ d, week, onPick }: { d: Hourly; week: Week; onPick: (start: string) => void }) {
  const [tip, setTip] = useState<{ date: string; x: number; y: number } | null>(null);
  const outer = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const show = (date: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const o = outer.current!.getBoundingClientRect();
    setTip({ date, x: Math.max(130, Math.min(o.width - 130, r.left + r.width / 2 - o.left)), y: r.top - o.top });
  };
  const lead = new Date(`${d.days[0].date}T12:00:00Z`).getUTCDay(); // empty cells before the first day
  const place = (k: number) => ({ gridColumn: Math.floor((k + lead) / 7) + 2, gridRow: ((k + lead) % 7) + 2 });
  const cols = Math.floor((d.days.length - 1 + lead) / 7) + 1;
  const selected = new Set(week.days.map((x) => x.date));
  const months = d.days.flatMap((day, k) => {
    if (k > 0 && !day.date.endsWith("-01")) return [];
    // The first month carries the year; January's is short, so it doesn't run into February on narrow screens.
    const label = k === 0 ? dayLabel(day.date, { month: "short", year: "numeric" })
      : day.date.slice(5, 7) === "01" ? `Jan ’${day.date.slice(2, 4)}` : dayLabel(day.date, { month: "short" });
    return [{ label, col: place(k).gridColumn + (k > 0 && (k + lead) % 7 > 3 ? 1 : 0) }];
  });

  // Keep the selected week in view when the calendar scrolls sideways (narrow screens).
  useEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>(".cal-day.sel");
    if (el && wrap.current) {
      const box = wrap.current;
      const x = el.offsetLeft - box.offsetLeft;
      if (x < box.scrollLeft || x > box.scrollLeft + box.clientWidth - 40) box.scrollLeft = x - box.clientWidth / 2;
    }
  }, [week.start]);

  const onKey = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    onPick(addDays(week.start, step));
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>(".cal-day[tabindex='0']")?.focus());
  };

  const shown = tip ? d.days.find((x) => x.date === tip.date) : undefined;
  return (
    <div className="cal-outer" ref={outer}>
      <div className="cal-wrap" ref={wrap}>
        <div className="cal" role="group" aria-label="Pick the first day of the week" onKeyDown={onKey}
          style={{ gridTemplateColumns: `24px repeat(${cols}, minmax(9px, 1fr))`, minWidth: 24 + cols * 12 }}>
          {months.map((m) => <span key={m.label} className="cal-month" style={{ gridColumn: `${m.col} / span 4` }}>{m.label}</span>)}
          {ROW_LABEL.map((l, r) => l && <span key={l} className="cal-wd" style={{ gridRow: r + 2 }}>{l}</span>)}
          {d.days.map((day, k) => (
            <button key={day.date} type="button" style={place(k)} data-level={Math.min(3, day.tags.length)}
              className={`cal-day${selected.has(day.date) ? " sel" : ""}`} tabIndex={day.date === week.start ? 0 : -1}
              aria-label={`${dayLabel(day.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}: ${day.tags.length ? day.tags.map((t) => t.text).join("; ") : "nothing unusual"}`}
              aria-pressed={day.date === week.start}
              onClick={() => onPick(day.date)} onPointerEnter={(e) => show(day.date, e.currentTarget)} onPointerLeave={() => setTip(null)}
              onFocus={(e) => show(day.date, e.currentTarget)} onBlur={() => setTip(null)} />
          ))}
        </div>
      </div>
      <div className="cal-legend">
        <span className="cal-scale" aria-hidden="true">None<i /><i /><i /><i />3+</span>
        <span>unusual signals in a day</span>
        <details>
          <summary>What counts?</summary>
          <ul>{Object.values(d.thresholds).map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      </div>
      {shown && tip && (
        <div className="cal-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <b>{dayLabel(shown.date, { weekday: "short", month: "short", day: "numeric" })}</b>
          {shown.tags.length ? shown.tags.map((t) => <span key={t.kind}>{t.text}</span>) : <span className="muted">Nothing unusual</span>}
        </div>
      )}
    </div>
  );
}
