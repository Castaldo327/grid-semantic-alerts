// ERCOT's hourly data for the demo's timelines (public/explore/ercot_hourly.json, pulled from the Grid
// Status API by the pipeline), loaded once, and the small demand curve the week views draw for each day.

import { useEffect, useState } from "react";
import type { Day, Hourly } from "./explore/data";

let cached: Promise<Hourly> | null = null;
const load = (): Promise<Hourly> => (cached ??= fetch(`${import.meta.env.BASE_URL}explore/ercot_hourly.json`).then((r) => r.json()));

export interface WeekData { days: Day[]; loads: number[][]; datasets: string[] }

/** The seven days from `start`, each with its 24 hourly demand readings (MW), once `active` first turns on. */
export function useWeek(start: string, active: boolean): WeekData | null {
  const [week, setWeek] = useState<WeekData | null>(null);
  useEffect(() => {
    if (!active || week) return;
    load().then((d: Hourly) => {
      const k = d.days.findIndex((x) => x.date === start);
      const days = d.days.slice(k, k + 7);
      setWeek({ days, datasets: d.datasets, loads: days.map((day) => d.series.load.slice(day.first_hour, day.first_hour + 24).map((v) => v ?? NaN)) });
    }).catch(() => {});
  }, [start, active, week]);
  return week;
}

export const gw = (mw: number) => `${(mw / 1000).toFixed(1)} GW`;

/** The week's lowest and highest demand, so every day's curve shares one scale. */
export function range(loads: number[][]): [number, number] {
  const all = loads.flat().filter(Number.isFinite);
  return [Math.min(...all), Math.max(...all)];
}

/** A day's demand as a filled sparkline, with optional dots (solid marks, hollow rings) at given hours,
 *  shaded bands behind given hours, and a scan line at a (fractional) hour. */
export function Curve({ loads, lo, hi, marks = [], rings = [], bands = [], scan = null }: {
  loads: number[]; lo: number; hi: number; marks?: number[]; rings?: number[]; bands?: number[]; scan?: number | null;
}) {
  const x = (h: number) => 4 + (h / 23) * 92; // inset a little, so dots at midnight aren't clipped
  const y = (v: number) => 46 - ((v - lo) / (hi - lo)) * 40;
  const line = `M${loads.map((v, h) => `${x(h).toFixed(2)} ${y(v).toFixed(2)}`).join(" L")}`;
  return (
    <span className="tl-curve">
      {bands.map((h) => <i key={`b${h}`} className="tl-band" style={{ left: `${x(h) - 2}%` }} />)}
      <svg viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
        <path className="area" d={`${line} L${x(23)} 48 L${x(0)} 48 Z`} />
        <path className="line" d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      {marks.map((h) => Number.isFinite(loads[h]) && (
        <i key={h} className="tl-mark" style={{ left: `${x(h)}%`, top: `${(y(loads[h]) / 48) * 100}%` }} />
      ))}
      {rings.map((h) => Number.isFinite(loads[h]) && (
        <i key={`r${h}`} className="tl-mark ring" style={{ left: `${x(h)}%`, top: `${(y(loads[h]) / 48) * 100}%` }} />
      ))}
      {scan !== null && <i className="tl-scan" style={{ left: `${x(scan)}%` }} />}
    </span>
  );
}

/** One of the week's threshold crossings on a grid reading (prices, reserves, demand), checked against the
 *  month before the week (scripts/abnormal_run.ts): verified abnormal if beyond anything in it. */
export interface Reading { date: string; kind: string; text: string; k: number; value: number; baseline: number; verified: boolean; p: number | null; caught: boolean }
export interface Episode { from: number; to: number; at: string; peak: number; p: number; headline: string; summary: string }
/** The test run on Aug 20–26, 2026: gpt-6-luna's P(abnormal) for each hour, the notifications and digest it
 *  wrote, and the verified readings to score it against. */
export interface Run {
  cutoff: number; p: (number | null)[]; episodes: Episode[]; digest: string; model: string; readings: Reading[];
  stats: {
    calls: number; input_tokens: number; cost_usd: number; latency_ms: { median: number; p95: number };
    notifications: { calls: number; input_tokens: number; output_tokens: number }; digest: { input_tokens: number; output_tokens: number };
  };
}

/** The alert run over every hour in the dataset (scripts/abnormal_year.ts): how often it actually fires. */
export interface Year { days: number; hours: number; abnormal_hours: number; episodes: number; episodes_per_year: number; input_tokens: number; cost_usd: number; from: string; to: string }
let year: Promise<Year> | null = null;
export function useYear(active: boolean): Year | null {
  const [y, setY] = useState<Year | null>(null);
  useEffect(() => {
    if (!active || y) return;
    (year ??= fetch(`${import.meta.env.BASE_URL}demo/abnormal_year.json`).then((x) => x.json())).then(setY).catch(() => {});
  }, [active, y]);
  return y;
}

let run: Promise<Run> | null = null;
export function useRun(active: boolean): Run | null {
  const [r, setR] = useState<Run | null>(null);
  useEffect(() => {
    if (!active || r) return;
    (run ??= fetch(`${import.meta.env.BASE_URL}demo/abnormal_2026-08-20.json`).then((x) => x.json())).then(setR).catch(() => {});
  }, [active, r]);
  return r;
}
