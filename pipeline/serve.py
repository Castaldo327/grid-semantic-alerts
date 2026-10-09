"""Local-only bridge for the page's live mode (for screen-sharing; never deployed).

    .venv/bin/python -m pipeline.serve            # http://127.0.0.1:8000
    cd web && VITE_LIVE_API=http://127.0.0.1:8000 npm run dev

POST /run {"sentence": "...", "scenario": "record_load" | "local_spike"}: gpt-6-luna compiles the
sentence (same validator and retries as 03_compile), the Decisions API answers every interval of
that scenario's cached state, and the rule + 30-minute cooldown decide the firings.
"""

import importlib
import json
import re

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pipeline.common import STATE

compile_mod = importlib.import_module("pipeline.03_compile")
decide_mod = importlib.import_module("pipeline.04_decide")
compose_mod = importlib.import_module("pipeline.05_compose")

app = FastAPI(title="semantic alerts live bridge")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?", allow_methods=["POST"],
                   allow_headers=["content-type"])

BY_SCENARIO = {p["scenario"]: p for p in compile_mod.PRESETS.values()}


class RunRequest(BaseModel):
    sentence: str
    scenario: str


@app.post("/run")
def run(req: RunRequest) -> dict:
    if req.scenario not in BY_SCENARIO:
        raise HTTPException(400, "unknown scenario")
    sentence = req.sentence.strip()
    if not 8 <= len(sentence) <= 300:
        raise HTTPException(400, "write the alert as one sentence (8-300 characters)")
    base = BY_SCENARIO[req.scenario]
    preset = {**base, "sentence": sentence,
              "extra_rule": base["extra_rule"] if re.search(r"local|congest|one area", sentence, re.I) else None}
    try:
        alert = compile_mod.compile_preset("live", preset)
    except SystemExit as exc:
        return {"error": f"gpt-6-luna could not compile that alert in 3 attempts: {str(exc)[:300]}"}
    state = json.loads((STATE / f"{req.scenario}.json").read_text())
    dec = decide_mod.run_alert(alert, state)
    dec["model"] = dec.get("model", {})
    out = compose_mod.compose(alert, state, dec, explain_on=False)
    clock = lambda i: compose_mod.pd.Timestamp(state["t"][i]).tz_convert("US/Central").strftime("%-I:%M %p")
    return {
        "alert": {k: alert[k] for k in ("alert_id", "questions", "rule")},
        "fired": [clock(i) for i in out["fired"]["semantic"]],
        "rule_true": sum(out["rule_true"]),
        "intervals": len(state["t"]),
        "latency_ms": {k: dec["stats"]["latency_ms"][k] for k in ("median", "p95")},
        "refusals": dec["stats"]["refusals"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
