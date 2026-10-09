// Threshold alerts in the preview, named the way Grid Status's series picker names them
// ("<dataset>: <column> (<location>)"). Grid Status fires when the condition holds for any new row;
// our data is hourly, so "greater than" checks the hour's highest value where we have it (the
// 5-minute peak, the highest SCED price) and "less than" its lowest, else the hourly average.

import type { Hourly, SeriesKey } from "./data.ts";

export type Op = ">" | ">=" | "<" | "<=";

export const OPS: { op: Op; label: string }[] = [
  { op: ">", label: "Greater than" },
  { op: ">=", label: "Greater than or equal to" },
  { op: "<", label: "Less than" },
  { op: "<=", label: "Less than or equal to" },
];

export interface SeriesOption {
  id: string;
  label: string;
  unit: string;
  mean: SeriesKey;
  hi?: SeriesKey;
  lo?: SeriesKey;
  start: { op: Op; value: number }; // a sensible first value when the series is picked
}

export const SERIES: SeriesOption[] = [
  { id: "load", label: "ERCOT Load: load", unit: "MW", mean: "load", hi: "load_max", start: { op: ">", value: 90000 } },
  { id: "hub", label: "ERCOT LMP By Settlement Point: lmp (HB_HUBAVG)", unit: "$/MWh", mean: "hub", hi: "hub_max", lo: "hub_min", start: { op: ">", value: 300 } },
  { id: "prc", label: "ERCOT PRC: prc", unit: "MW", mean: "prc", lo: "prc_min", start: { op: "<", value: 6000 } },
  { id: "nspin", label: "ERCOT MCPC SCED: mcpc (NSPIN)", unit: "$/MWh", mean: "nspin", hi: "nspin_max", start: { op: ">", value: 100 } },
  { id: "wind", label: "ERCOT Fuel Mix: wind", unit: "MW", mean: "wind", start: { op: "<", value: 3000 } },
  { id: "solar", label: "ERCOT Fuel Mix: solar", unit: "MW", mean: "solar", start: { op: ">", value: 30000 } },
  { id: "battery", label: "ERCOT Energy Storage Resources: total_discharging", unit: "MW", mean: "bat_dis", start: { op: ">", value: 10000 } },
  { id: "dfw", label: "ERCOT Temperature Forecast By Weather Zone: north_central", unit: "°F", mean: "temp_dfw", start: { op: ">", value: 100 } },
  { id: "houston", label: "ERCOT Temperature Forecast By Weather Zone: coast", unit: "°F", mean: "temp_hou", start: { op: ">", value: 95 } },
];

export interface Threshold { series: string; op: Op; value: number }

export const seriesOf = (t: Threshold) => SERIES.find((s) => s.id === t.series) ?? SERIES[0];

/** The hourly values the check reads: each hour's high for > and >=, its low for < and <=. */
export function checkedValues(d: Hourly, t: Threshold, from: number, to: number): (number | null)[] {
  const s = seriesOf(t);
  const key = t.op.startsWith(">") ? s.hi ?? s.mean : s.lo ?? s.mean;
  return d.series[key].slice(from, to);
}

export function holds(t: Threshold, v: number | null): boolean {
  if (v === null) return false;
  return t.op === ">" ? v > t.value : t.op === ">=" ? v >= t.value : t.op === "<" ? v < t.value : v <= t.value;
}

/** Hours that send a notification: the condition holds and nothing was sent in the last `timeout` minutes. */
export function notifications(flags: boolean[], timeoutMinutes: number | null): number[] {
  const out: number[] = [];
  let last = -Infinity;
  flags.forEach((f, k) => {
    if (f && (k - last) * 60 >= (timeoutMinutes ?? 0)) {
      out.push(k);
      last = k;
    }
  });
  return out;
}
