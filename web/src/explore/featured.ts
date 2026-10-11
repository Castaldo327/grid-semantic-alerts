// The Overview's one alert: the winter-freeze example (pipeline/08_range_state.py), a situation a customer
// can say in a sentence but can't set as a threshold. Its sentence, name and saved run come from that
// example; RULES are the threshold alerts it would take to try it today, one for each part of the
// sentence. Grid Status's alerts can't combine them or say "not just", so each one fires on its own.
// No UI code here.

import type { Threshold } from "./series.ts";

export const FEATURED_WEEK = "2026-01-22";

// `part` is the piece of the sentence an alert stands in for; `line` its condition in a few words.
export const RULES: (Threshold & { part: string; line: string })[] = [
  { part: "the freeze", line: "Dallas ≤ 32°F", series: "dfw", op: "<=", value: 32 },
  { part: "short of reserves", line: "Reserves < 5.5 GW", series: "prc", op: "<", value: 5500 },
  { part: "short of reserves", line: "Non-spin ≥ $100", series: "nspin", op: ">=", value: 100 },
  { part: "driving up prices", line: "Hub price > $300", series: "hub", op: ">", value: 300 },
];
