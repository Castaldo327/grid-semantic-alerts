// Shape of web/public/demo/<alert_id>.json, written by pipeline/05_compose.py.

export type Kind = "probability" | "choice" | "score";

export interface Question {
  id: string;
  kind: Kind;
  text: string;
  options: string[];
}

export interface AnswerJSON {
  probs: Record<string, number>;
  expected?: number;
  refused?: boolean;
}

export interface Threshold {
  series: string;
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

export interface Explanation {
  kind: "fired" | "declined";
  text: string;
  attempts: number;
  checked: boolean;
  unsupported_numbers?: string[];
  meta_terms?: string[];
}

export interface Stats {
  calls: number;
  questions_per_call: number;
  decisions: number;
  latency_ms: { median: number; p95: number; min: number; max: number };
  input_tokens: { min: number; max: number; total: number };
  cost_usd: number;
  refusals: number;
  concurrency: number;
  measured_on: string;
}

export interface Demo {
  alert: {
    preset: string;
    alert_id: string;
    sentence: string;
    questions: Question[];
    primary: string;
    contrast: { question: string; want: string; avoid: string } | null;
    rule: string;
    baseline_threshold: Threshold;
    baseline_label: string;
    intent: { want: string; avoid: string | null };
  };
  compile: { model: Record<string, string>; attempts: number; errors: string[] };
  scenario: {
    scenario: "record_load";
    title: string;
    day: string;
    timezone: string;
    blog_url: string;
    coarse_series: string[];
    series_source: Record<string, string>;
    missing: Record<string, number>;
  };
  datasets: string[];
  t: string[];
  series: Record<string, (number | null)[]>;
  prose: string[];
  decisions: Record<string, AnswerJSON>[];
  decision_latency_ms: number[];
  rule_true: boolean[];
  threshold_true: boolean[];
  fired: { semantic: number[]; threshold: number[] };
  cooldown_minutes: number;
  explanations: Record<string, Explanation>;
  explained_by: Record<string, string>;
  model: Record<string, string>;
  decision_stats: Stats;
}

export interface IndexEntry {
  preset: string;
  alert_id: string;
  scenario: string;
  file: string;
}
