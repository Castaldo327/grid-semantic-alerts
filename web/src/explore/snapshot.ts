// The text the decision model reads for one hour, written from the hourly numbers. It uses only that
// hour and the hours before it, so nothing comes from the future: "the highest in the past 30 days",
// never "the highest of the week".

import { TZ, timeOf, type Hourly, type SeriesKey } from "./data.ts";

/** What a snapshot covers, for the compile prompt (03_compile.py's `snapshot` field). */
export const SNAPSHOT_DESCRIPTION =
  "one hour (time, weekday and date); the temperature across ERCOT weighted by demand, and in Dallas-Fort " +
  "Worth and Houston; ERCOT demand (hourly average and 5-minute peak) and its change from " +
  "the hour before; solar output; wind output, this hour and over the past 24 hours; battery discharging and " +
  "charging; net load (demand minus wind and solar); hub real-time price (hourly average, low and high) and " +
  "the day-ahead price; non-spinning reserve price (average and high); physical responsive capability " +
  "(operating reserves: average and low) and its change from the hour before; and which of these are the " +
  "highest or lowest in the past 30 days.";

const WINDOW = 30 * 24;

const gw = (mw: number) => `${(mw / 1000).toFixed(1)} GW`;
const deg = (f: number) => `${Math.round(f)}°F`;
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}/MWh`;
const hour = (t: Date) => t.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric" });

/** Max or min of a series over the 30 days before hour i, or null without (nearly) 30 days of data. */
function prior(d: Hourly, key: SeriesKey, i: number, fn: "max" | "min"): number | null {
  const s = d.series[key];
  let n = 0;
  let best = fn === "max" ? -Infinity : Infinity;
  for (let k = Math.max(0, i - WINDOW); k < i; k++) {
    const v = s[k];
    if (v === null) continue;
    n++;
    best = fn === "max" ? Math.max(best, v) : Math.min(best, v);
  }
  return n >= WINDOW - 24 ? best : null;
}

/** Index of the first hour of hour i's day (Central). */
function dayStart(d: Hourly, i: number): number {
  const day = d.days.find((x) => i >= x.first_hour && i < x.first_hour + x.hours);
  return day ? day.first_hour : i;
}

export function snapshot(d: Hourly, i: number): string {
  const v = (k: SeriesKey, j = i): number | null => (j >= 0 ? d.series[k][j] : null);
  const t = timeOf(d, i);
  const date = t.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const p: string[] = [`Hourly snapshot of the ERCOT grid for ${hour(t)} to ${hour(timeOf(d, i + 1))} on ${date}, Texas time.`];
  const d0 = dayStart(d, i);

  const temp = v("temp");
  if (temp !== null) {
    const dfw = v("temp_dfw");
    const hou = v("temp_hou");
    let s = `The demand-weighted temperature across ERCOT was ${deg(temp)}`;
    if (dfw !== null && hou !== null) s += ` (${deg(dfw)} in Dallas-Fort Worth, ${deg(hou)} in Houston)`;
    const hi = prior(d, "temp", i, "max");
    const lo = prior(d, "temp", i, "min");
    if (hi !== null && temp > hi) s += ", the hottest hour in the past 30 days";
    else if (lo !== null && temp < lo) s += ", the coldest hour in the past 30 days";
    p.push(s + ".");
  }

  const load = v("load");
  if (load !== null) {
    const peak = v("load_max");
    const before = v("load", i - 1);
    let s = `Demand averaged ${gw(load)}`;
    if (peak !== null) s += ` and peaked at ${gw(peak)}`;
    if (before !== null) {
      const dl = load - before;
      s += Math.abs(dl) < 300 ? ", about the same as the hour before" : `, ${dl > 0 ? "up" : "down"} ${gw(Math.abs(dl))} from the hour before`;
    }
    s += ".";
    const hi = prior(d, "load_max", i, "max");
    if (peak !== null && hi !== null && peak > hi) s += " That peak is the highest in the past 30 days.";
    p.push(s);
  }

  const solar = v("solar");
  if (solar !== null) {
    let s = `Solar averaged ${gw(solar)}`;
    let pk = -Infinity;
    let pkAt = -1;
    for (let k = d0; k < i; k++) {
      const x = v("solar", k);
      if (x !== null && x > pk) { pk = x; pkAt = k; }
    }
    if (pkAt >= 0 && pk - solar > 2000) s += `, down from ${gw(pk)} at ${hour(timeOf(d, pkAt))}`;
    p.push(s + ".");
  }

  const wind = v("wind");
  if (wind !== null) {
    let s = `Wind averaged ${gw(wind)}`;
    const lo = prior(d, "wind", i, "min");
    if (lo !== null && wind < lo) s += ", the lowest hourly average in the past 30 days";
    s += ".";
    const day = d.series.wind.slice(Math.max(0, i - 23), i + 1).filter((x): x is number => x !== null);
    if (day.length >= 20) s += ` Over the past 24 hours it averaged ${gw(day.reduce((a, b) => a + b, 0) / day.length)}.`;
    p.push(s);
  }

  const dis = v("bat_dis");
  if (dis !== null) {
    const chg = v("bat_chg");
    const before = v("bat_dis", i - 1);
    let s = `Batteries discharged ${gw(dis)}${chg !== null ? ` and charged ${gw(chg)}` : ""} on average`;
    if (before !== null && Math.abs(dis - before) >= 500) s += `; discharge was ${gw(before)} the hour before`;
    p.push(s + ".");
  }

  const net = v("net");
  if (net !== null) {
    let s = `Net load (demand minus wind and solar) averaged ${gw(net)}`;
    const hi = prior(d, "net", i, "max");
    const today = d.series.net.slice(d0, i).filter((x): x is number => x !== null);
    if (hi !== null && net > hi) s += ", the highest in the past 30 days";
    else if (i - d0 >= 12 && today.length && net > Math.max(...today)) s += ", the highest so far today";
    p.push(s + ".");
  }

  const hub = v("hub");
  if (hub !== null) {
    const hi = v("hub_max");
    const lo = v("hub_min");
    const da = v("da");
    let s = `The hub average real-time price averaged ${usd(hub)}`;
    if (hi !== null && lo !== null) s += `, ranging from ${usd(lo)} to ${usd(hi)} within the hour`;
    if (da !== null) s += `; the day-ahead price for this hour was ${usd(da)}`;
    s += ".";
    const hi30 = prior(d, "hub_max", i, "max");
    const lo30 = prior(d, "hub_min", i, "min");
    if (hi !== null && hi30 !== null && hi > hi30) s += " The high is the highest in the past 30 days.";
    if (lo !== null && lo30 !== null && lo < lo30) s += " The low is the lowest in the past 30 days.";
    p.push(s);
  }

  const ns = v("nspin");
  if (ns !== null) {
    const hi = v("nspin_max");
    let s = hi !== null && hi - ns >= 1
      ? `The non-spinning reserve price averaged ${usd(ns)} and reached ${usd(hi)}.`
      : `The non-spinning reserve price was ${usd(ns)}.`;
    const hi30 = prior(d, "nspin_max", i, "max");
    if (hi !== null && hi30 !== null && hi > hi30) s += " That is the highest in the past 30 days.";
    p.push(s);
  }

  const prc = v("prc");
  if (prc !== null) {
    const lo = v("prc_min");
    const before = v("prc", i - 1);
    let s = `Operating reserves (physical responsive capability) averaged ${gw(prc)}`;
    if (lo !== null) s += `, with a low of ${gw(lo)}`;
    if (before !== null && Math.abs(prc - before) >= 500) s += `, ${prc > before ? "up" : "down"} from ${gw(before)} the hour before`;
    s += ".";
    const lo30 = prior(d, "prc_min", i, "min");
    if (lo !== null && lo30 !== null && lo < lo30) s += " That low is the lowest in the past 30 days.";
    p.push(s);
  }

  return p.join(" ");
}
