// The week explorer's dataset: public/explore/ercot_hourly.json, written by pipeline/08_range_state.py.
// One value per hour on a regular UTC grid starting at t0, including 30 days of context before the
// first selectable day (for "the highest in the past 30 days").

export type SeriesKey =
  | "load" | "load_max" | "solar" | "wind" | "net" | "bat_dis" | "bat_chg"
  | "hub" | "hub_max" | "hub_min" | "da" | "nspin" | "nspin_max" | "prc" | "prc_min";

export interface DayTag { kind: string; text: string }
export interface Day { date: string; first_hour: number; hours: number; tags: DayTag[] }
export interface SuggestedWeek { start: string; title: string; note: string; example: string }

export interface Hourly {
  range: { first_day: string; last_day: string; context_days: number; timezone: string };
  t0: string;
  hours: number;
  series: Record<SeriesKey, (number | null)[]>;
  days: Day[];
  thresholds: Record<string, string>;
  weeks: SuggestedWeek[];
  datasets: string[];
}

export const TZ = "America/Chicago";
const HOUR = 3_600_000;

export const timeOf = (d: Hourly, i: number) => new Date(Date.parse(d.t0) + i * HOUR);

/** Latest day a full week can start on. */
export const lastStart = (d: Hourly) => d.days[Math.max(0, d.days.length - 7)].date;

export interface Week { start: string; days: Day[]; from: number; to: number }

/** The seven days starting at `start` (clamped to the range), and their hours [from, to). */
export function weekOf(d: Hourly, start: string): Week {
  let k = d.days.findIndex((x) => x.date === start);
  if (k < 0) k = start < d.days[0].date ? 0 : d.days.length - 7;
  k = Math.max(0, Math.min(k, d.days.length - 7));
  const days = d.days.slice(k, k + 7);
  const last = days[days.length - 1];
  return { start: days[0].date, days, from: days[0].first_hour, to: last.first_hour + last.hours };
}

/** "2026-07-19" moved by n days. */
export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

const noonUTC = (date: string) => new Date(`${date}T12:00:00Z`);

/** "Sun, Jul 19" (date strings are calendar days, so format them in UTC). */
export const dayLabel = (date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) =>
  noonUTC(date).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

/** "Jul 19 – 25, 2026" or "Jul 29 – Aug 4, 2026". */
export function weekLabel(w: Week): string {
  const a = noonUTC(w.days[0].date);
  const b = noonUTC(w.days[w.days.length - 1].date);
  const m = (t: Date) => t.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" });
  const tail = a.getUTCMonth() === b.getUTCMonth() ? `${b.getUTCDate()}` : `${m(b)} ${b.getUTCDate()}`;
  return `${m(a)} ${a.getUTCDate()} – ${tail}, ${b.getUTCFullYear()}`;
}

/** "8 PM" for the hour starting at index i, in Central time. */
export const hourLabel = (d: Hourly, i: number) =>
  timeOf(d, i).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric" });
