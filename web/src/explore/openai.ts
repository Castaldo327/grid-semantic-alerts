// gpt-6-luna on OpenAI, called straight from the browser with the visitor's own key (and from Node by
// scripts/save_runs.ts). The TypeScript twin of pipeline/luna.py:
//   decide()    POST /v1/decisions  typed answers with probabilities, no text. One per snapshot.
//   generate()  POST /v1/responses  JSON text. Used to compile the alert.
// The key is sent only to api.openai.com.

import type { AnswerJSON, Question } from "../types.ts";

export const MODEL = "gpt-6-luna";
export const USD_PER_M_INPUT = 0.1; // published price for /v1/decisions with gpt-6-luna
const API = "https://api.openai.com/v1";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Optional request cache: scripts/save_runs.ts keeps one on disk so a re-run spends nothing. */
export interface Cache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Client {
  key: string;
  signal?: AbortSignal;
  cache?: Cache;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason); }, { once: true });
  });

/** POST with retries on rate limits (429, except an empty quota), server errors and dropped connections. */
async function post(c: Client, path: string, body: object): Promise<{ json: any; ms: number }> {
  const cacheKey = JSON.stringify({ path, body });
  const hit = await c.cache?.get(cacheKey);
  if (hit) return hit as { json: unknown; ms: number };
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(API + path, {
        method: "POST",
        signal: c.signal,
        headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // In a browser this is either a dropped connection or a request OpenAI refused before reading
      // it: its 401 for a bad key carries no CORS headers, so the page can't see the status.
      if (c.signal?.aborted) throw e;
      if (attempt >= 1) throw new ApiError(0, "unreachable", "No readable response from api.openai.com.");
      await sleep(600, c.signal);
      continue;
    }
    if (res.ok) {
      const out = { json: await res.json(), ms: Math.round(performance.now() - started) };
      await c.cache?.set(cacheKey, out);
      return out;
    }
    const err = await res.json().catch(() => null);
    const code = String(err?.error?.code ?? err?.error?.type ?? res.status);
    const message = String(err?.error?.message ?? res.statusText);
    const retry = (res.status === 429 && code !== "insufficient_quota") || res.status >= 500;
    if (retry && attempt < 5) {
      await sleep(1000 * 2 ** attempt + Math.random() * 500, c.signal);
      continue;
    }
    throw new ApiError(res.status, code, message);
  }
}

/** A plain-language message for an error from either endpoint. */
export function describe(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "unreachable")
      return "OpenAI didn't accept the request. This usually means the API key is wrong or inactive (a browser can't read OpenAI's reply to a bad key). Check the key and your connection, then try again.";
    if (e.status === 401) return "OpenAI rejected the API key. Check that it's correct and active.";
    if (e.code === "insufficient_quota") return "This OpenAI account is out of credit (insufficient_quota).";
    if (e.status === 429) return "OpenAI kept rate-limiting the requests. Wait a minute and run again.";
    if (e.status === 403 || e.status === 404)
      return `This key can't use ${MODEL} or the Decisions API (${e.status}): ${e.message}`;
    return `OpenAI returned an error (${e.status || e.code}): ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Our question kinds as Decisions API questions (same mapping as pipeline/luna.py). */
export function toApi(q: Question) {
  if (q.kind === "probability") return { type: "predicate", name: q.id, instructions: q.text };
  if (q.kind === "choice") return { type: "choice", name: q.id, instructions: q.text, choices: q.options.map((o) => ({ value: o })) };
  return { type: "score", name: q.id, instructions: q.text, levels: q.options.map((o) => ({ label: o })) };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export interface Decision {
  answers: Record<string, AnswerJSON>;
  inputTokens: number;
  ms: number;
}

/** All of an alert's questions about one snapshot, in one request. A refusal is kept as refused. */
export async function decide(c: Client, input: string, questions: Question[]): Promise<Decision> {
  const { json, ms } = await post(c, "/decisions", { model: MODEL, input, questions: questions.map(toApi) });
  const byName = new Map<string, { type: string; probability?: number; score?: number; probabilities?: { value: string | number; probability: number }[] }>(
    (json.answers ?? []).map((a: { name: string }) => [a.name, a]),
  );
  const answers: Record<string, AnswerJSON> = {};
  for (const q of questions) {
    const a = byName.get(q.id);
    if (!a || a.type === "refusal") {
      answers[q.id] = { probs: {}, refused: true };
    } else if (q.kind === "probability") {
      const p = Number(a.probability);
      answers[q.id] = { probs: { yes: r4(p), no: r4(1 - p) } };
    } else if (q.kind === "choice") {
      const got = new Map((a.probabilities ?? []).map((x) => [String(x.value), Number(x.probability)]));
      answers[q.id] = { probs: Object.fromEntries(q.options.map((o) => [o, r4(got.get(o) ?? 0)])) };
    } else {
      const got = new Map((a.probabilities ?? []).map((x) => [Number(x.value), Number(x.probability)]));
      answers[q.id] = { probs: Object.fromEntries(q.options.map((o, k) => [o, r4(got.get(k) ?? 0)])), expected: r4(Number(a.score)) };
    }
  }
  return { answers, inputTokens: Number(json.usage?.input_tokens ?? 0), ms };
}

export type Message = { role: "system" | "user" | "assistant"; content: string };

/** Generate JSON text with the Responses API (JSON mode). */
export async function generate(c: Client, messages: Message[]): Promise<{ text: string; ms: number }> {
  const { json, ms } = await post(c, "/responses", { model: MODEL, input: messages, text: { format: { type: "json_object" } } });
  if (typeof json.output_text === "string") return { text: json.output_text, ms };
  const parts = (json.output ?? [])
    .filter((o: { type: string }) => o.type === "message")
    .flatMap((o: { content?: { type: string; text?: string }[] }) => o.content ?? [])
    .filter((p: { type: string }) => p.type === "output_text")
    .map((p: { text: string }) => p.text);
  return { text: parts.join(""), ms };
}

/** Run task(0..n-1) with at most `limit` in flight. Rejects on the first error. */
export async function pool<T>(n: number, limit: number, task: (i: number) => Promise<T>): Promise<T[]> {
  const out = new Array<T>(n);
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      out[i] = await task(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
  return out;
}
