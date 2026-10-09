"""gpt-6-luna, the only model in the pipeline, through two OpenAI endpoints:

  decide()  POST /v1/decisions  (Decisions API): typed answers with probabilities, no text.
            Used on every grid snapshot.
  chat()    Responses API, JSON mode: generates text. Used once per alert to compile the
            sentence into questions, and once per firing to write the explanation.

gpt-6-luna does not accept temperature or seed, so generated text is not guaranteed to repeat.
Every raw response is saved by the caller.

Our question kinds map onto Decisions API types:
  probability -> predicate (probability the statement is true; reported as {"yes": p, "no": 1 - p})
  choice      -> choice    (choices = our option labels, as values)
  score       -> score     (levels = our option labels, lowest first)
A refused answer is kept as `refused: true` with no probabilities; the rule treats it as not firing.
"""

import hashlib
import json
import time
from typing import Literal

from dotenv import dotenv_values
from pydantic import BaseModel

from pipeline.common import DATA, ROOT

# Every request and its response are cached under data/cache/luna/, keyed by a hash of the request,
# so re-running the pipeline replays identical outputs (gpt-6-luna has no temperature/seed) and
# spends nothing. Delete the folder to query the model again.
CACHE = DATA / "cache" / "luna"


def _cached(kind: str, request: dict, call):
    key = hashlib.sha256(json.dumps({"kind": kind, **request}, sort_keys=True).encode()).hexdigest()[:24]
    path = CACHE / kind / f"{key}.json"
    if path.exists():
        return json.loads(path.read_text())
    started = time.perf_counter()
    response = call()
    entry = {"request": request, "response": response, "latency_ms": (time.perf_counter() - started) * 1000,
             "at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entry))
    return entry

MODEL = "gpt-6-luna"
USD_PER_M_INPUT = 0.10  # published price for /v1/decisions with gpt-6-luna
_client = None


class Question(BaseModel):
    id: str
    kind: Literal["probability", "choice", "score"]
    text: str
    options: list[str]


class Answer(BaseModel):
    id: str
    kind: str
    probs: dict[str, float]  # option label -> probability, in the question's option order
    expected: float | None = None  # probability-weighted score (score questions only)
    refused: bool = False


class Decision(BaseModel):
    answers: list[Answer]
    latency_ms: float  # wall-clock HTTPS round trip, measured here
    input_tokens: int


def client():
    global _client
    if _client is None:
        from openai import OpenAI

        env = dotenv_values(ROOT / ".env")
        key = env.get("OPENAI_API_KEY") or env.get("OPEN_AI_KEY")
        if not key:
            raise SystemExit("OPENAI_API_KEY (or OPEN_AI_KEY) missing from .env")
        _client = OpenAI(api_key=key, max_retries=5, timeout=120)
    return _client


def info() -> dict:
    return {"name": MODEL, "decide": "OpenAI Decisions API (public beta), POST /v1/decisions",
            "generate": "OpenAI Responses API, JSON mode", "price": f"${USD_PER_M_INPUT:.2f} per 1M input tokens (decisions)",
            "options": "API defaults (temperature and seed are not supported by this model)"}


def to_api(q: Question) -> dict:
    if q.kind == "probability":
        return {"type": "predicate", "name": q.id, "instructions": q.text}
    if q.kind == "choice":
        return {"type": "choice", "name": q.id, "instructions": q.text, "choices": [{"value": o} for o in q.options]}
    return {"type": "score", "name": q.id, "instructions": q.text, "levels": [{"label": o} for o in q.options]}


def decide_full(state: str, questions: list[Question]) -> Decision:
    """All of an alert's questions in one request. latency_ms is the original (uncached) round trip."""
    req = {"model": MODEL, "input": state, "questions": [to_api(q) for q in questions]}
    entry = _cached("decisions", req, lambda: client().decisions.create(**req).model_dump(mode="json"))
    resp = entry["response"]
    by_name = {a["name"]: a for a in resp["answers"]}
    answers = []
    for q in questions:
        a = by_name[q.id]
        if a["type"] == "refusal":
            answers.append(Answer(id=q.id, kind=q.kind, probs={}, refused=True))
        elif q.kind == "probability":
            p = float(a["probability"])
            answers.append(Answer(id=q.id, kind=q.kind, probs={"yes": p, "no": round(1 - p, 4)}))
        elif q.kind == "choice":
            got = {str(x["value"]): float(x["probability"]) for x in a["probabilities"]}
            answers.append(Answer(id=q.id, kind=q.kind, probs={o: got.get(o, 0.0) for o in q.options}))
        else:
            got = {int(x["value"]): float(x["probability"]) for x in a["probabilities"]}
            answers.append(Answer(id=q.id, kind=q.kind, probs={o: got.get(i, 0.0) for i, o in enumerate(q.options)},
                                  expected=float(a["score"])))
    return Decision(answers=answers, latency_ms=entry["latency_ms"], input_tokens=int(resp["usage"]["input_tokens"]))


def decide(state: str, questions: list[Question]) -> list[Answer]:
    return decide_full(state, questions).answers


def chat(messages: list[dict], fmt: str | None = "json") -> tuple[str, float]:
    """Generate text with gpt-6-luna on the Responses API. Returns (content, latency_ms)."""
    req = {"model": MODEL, "input": messages, **({"text": {"format": {"type": "json_object"}}} if fmt == "json" else {})}
    entry = _cached("responses", req, lambda: {"output_text": client().responses.create(**req).output_text})
    return entry["response"]["output_text"], entry["latency_ms"]


if __name__ == "__main__":
    # Smoke test on a trivial known case.
    q = Question(id="issue", kind="choice", text="What is the customer's issue?",
                 options=["billing", "shipping", "technical", "none of these"])
    d = decide_full("Charged twice for order #4417.", [q])
    print(d.model_dump())
    assert max(d.answers[0].probs, key=d.answers[0].probs.get) == "billing"
