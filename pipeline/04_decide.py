"""Run gpt-6-luna (Decisions API) on every interval of each alert's scenario: all of the alert's
questions in one request. Writes data/decisions/<alert_id>.json.

Latency is the wall-clock HTTPS round trip to api.openai.com for each request, measured here.
Requests run CONCURRENCY at a time; each request's latency is still its own round trip.
"""

import json
from concurrent.futures import ThreadPoolExecutor

from pipeline import luna
from pipeline.common import ALERTS, DECISIONS, STATE, log, write_json
from pipeline.luna import Question

CONCURRENCY = 6


def pct(xs: list[float], q: float) -> float:
    s = sorted(xs)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def run_alert(alert: dict, state: dict) -> dict:
    questions = [Question(**q) for q in alert["questions"]]
    intervals = state["intervals"]
    with ThreadPoolExecutor(CONCURRENCY) as pool:
        results = list(pool.map(lambda it: luna.decide_full(it["prose"], questions), intervals))
    rows = []
    for it, d in zip(intervals, results):
        rows.append({"t": it["t"], "answers": {a.id: {"probs": {k: round(v, 4) for k, v in a.probs.items()},
                                                      **({"expected": round(a.expected, 4)} if a.expected is not None else {}),
                                                      **({"refused": True} if a.refused else {})}
                                               for a in d.answers},
                     "latency_ms": round(d.latency_ms, 1), "input_tokens": d.input_tokens})
    lat = [d.latency_ms for d in results]
    toks = [d.input_tokens for d in results]
    stats = {
        "calls": len(rows),
        "questions_per_call": len(questions),
        "decisions": len(rows) * len(questions),
        "latency_ms": {"median": round(pct(lat, 0.5), 1), "p95": round(pct(lat, 0.95), 1),
                       "min": round(min(lat), 1), "max": round(max(lat), 1)},
        "input_tokens": {"min": min(toks), "max": max(toks), "total": sum(toks)},
        "cost_usd": round(sum(toks) / 1e6 * luna.USD_PER_M_INPUT, 4),
        "refusals": sum(a.refused for d in results for a in d.answers),
        "concurrency": CONCURRENCY,
        "measured_on": "HTTPS round trip from a laptop in the US to api.openai.com",
    }
    log.info("%s: %d calls, median %.0f ms, p95 %.0f ms, $%.4f", alert["alert_id"], len(rows),
             stats["latency_ms"]["median"], stats["latency_ms"]["p95"], stats["cost_usd"])
    return {"alert_id": alert["alert_id"], "scenario": state["scenario"], "questions": alert["questions"],
            "model": luna.info(), "rows": rows, "stats": stats}


def main() -> None:
    index = json.loads((ALERTS / "index.json").read_text())
    for entry in index.values():
        alert = json.loads((ALERTS / f"{entry['alert_id']}.json").read_text())
        state = json.loads((STATE / f"{entry['scenario']}.json").read_text())
        write_json(DECISIONS / f"{entry['alert_id']}.json", run_alert(alert, state))


if __name__ == "__main__":
    main()
