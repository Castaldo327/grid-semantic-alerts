// Local-only live mode (shown only when VITE_LIVE_API is set at build/dev time; never in production).
// Sends a custom sentence to pipeline/serve.py, which compiles it with gpt-6-luna and runs the
// Decisions API over the selected scenario's cached state.

import { useState } from "react";

interface LiveResult {
  alert: { alert_id: string; questions: { id: string; kind: string; text: string; options: string[] }[]; rule: string };
  fired: string[];
  rule_true: number;
  intervals: number;
  latency_ms: { median: number; p95: number };
  refusals: number;
  error?: string;
}

export function LiveBox({ scenario }: { scenario: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LiveResult | null>(null);
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      const r = await fetch(`${import.meta.env.VITE_LIVE_API}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sentence: text, scenario }),
      });
      setRes(await r.json());
    } catch (e) {
      setRes({ error: String(e) } as LiveResult);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="live">
      <h2>Live mode <span className="muted small">· local only, calls gpt-6-luna through pipeline/serve.py</span></h2>
      <div className="live-row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write an alert in plain English…" />
        <button type="button" onClick={run} disabled={busy || !text.trim()}>{busy ? "Running…" : "Compile and run"}</button>
      </div>
      {res?.error && <p className="bad">{res.error}</p>}
      {res && !res.error && (
        <pre className="code"><code>{res.alert.questions.map((q) => `${q.kind.padEnd(11)} ${q.id}  "${q.text}"  [${q.options.join(", ")}]`).join("\n")}
{`\nrule        ${res.alert.rule}\nrule true   ${res.rule_true} of ${res.intervals} intervals\nfired at    ${res.fired.join(", ") || "never"}\nlatency     median ${res.latency_ms.median} ms, p95 ${res.latency_ms.p95} ms\nrefusals    ${res.refusals} answers refused (counted as not firing)`}</code></pre>
      )}
    </section>
  );
}
