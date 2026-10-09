# Sentence alerts for ERCOT

Grid alerts usually watch one number, such as ERCOT load above 90,000 MW. This demo tests alerts
written as a sentence instead: *"Tell me when ERCOT is actually heading toward scarcity, not just
setting demand records."* gpt-6-luna turns the sentence into two questions **once**. The OpenAI
Decisions API answers them for **every** 5-minute snapshot of the grid, returning probabilities
rather than text, and ordinary code decides whether to fire.

It runs on one real day, July 22, 2026, using Grid Status API data. It is an independent concept
demo, not affiliated with Grid Status.

**Live demo:** _(Vercel URL)_ · **Results, including failures:** [FINDINGS.md](FINDINGS.md)

## How it works

```
 "Tell me when ERCOT is heading toward scarcity..."
        │
        ▼  once per alert          gpt-6-luna, Responses API (JSON)       pipeline/03_compile.py
 ┌─────────────────────────────────────────────────────────────────┐
 │ probability scarcity_approaching "Is ERCOT heading toward...?"  │  validated with pydantic,
 │ choice      ercot_state  [scarcity approaching | demand record  │  rejected and retried (≤3)
 │                           only | nothing unusual]               │  if the rule doesn't rule
 │ rule  scarcity_approaching >= 0.7 && ercot_state.'…' >= 0.6     │  out the "not" case
 └─────────────────────────────────────────────────────────────────┘
        │
        ▼  every 5 minutes          gpt-6-luna, Decisions API             pipeline/04_decide.py
 grid snapshot as short prose ──► { scarcity_approaching: P(yes)=0.72,
 (Grid Status API data,            ercot_state: {scarcity approaching: 1.00, ...} }
  pipeline/02_state.py)
        │
        ▼  plain code, no model     rule + 30-min cooldown                pipeline/rules.py, web/src/rule.ts
 fire / don't fire ──► on a firing only: a 1–2 sentence explanation (gpt-6-luna, numbers
                       checked against the snapshot)                      pipeline/05_compose.py
```

```
pipeline/   (Python, runs locally, never deployed)
  01_fetch.py    Grid Status API pulls → data/raw/<scenario>/*.parquet (cached)
  02_state.py    per-interval series + prose state → data/state/<scenario>.json
  03_compile.py  sentence → typed questions + rule → data/alerts/<id>.json
  04_decide.py   Decisions API over every interval → data/decisions/<id>.json
  05_compose.py  firings (sentence + threshold), explanations → web/public/demo/<id>.json
  06_whatif.py   8 GW of batteries removed → web/public/demo/whatif_<id>.json (kept separate)
  luna.py        the only model client (Decisions + Responses API), with a request cache
  serve.py       local-only FastAPI bridge for live mode
web/        (Vite + React + TypeScript, static, deployed)
```

The page recomputes every firing in the browser from the precomputed answers (`web/src/rule.ts`)
and shows whether it matches the pipeline. `npm run check-rules` checks the same thing in CI
style.

## The test day

On July 22, 2026 ([Grid Status blog](https://blog.gridstatus.io/ercot-record-july-2026)), ERCOT set
an all-time demand record of 91.3 GW, but batteries kept prices low and reserves near 17 GW all
afternoon. The grid only tightened after sunset.

| alert | fired |
|---|---|
| Threshold: `ERCOT load > 90,000 MW` | 8 times, 2:55–6:25 PM (the record afternoon) |
| Sentence: "...heading toward scarcity, not just setting demand records" | 4 times, 8:10–10:25 PM (as reserves fell to 6.6 GW) |

## Regenerate

You need your own keys in `.env` (gitignored):

```
GRIDSTATUS_API_KEY=...      # free tier is enough: the full pull is ~25 requests
OPENAI_API_KEY=...          # Decisions API access for gpt-6-luna (OPEN_AI_KEY also works)
```

```sh
make setup        # uv venv + pip install, npm install
make all          # fetch (cached) → state → compile → decide → compose → what-if
make preview      # build and serve the site locally
make check        # TS/Python rule parity + secret scan of the build
```

Grid Status pulls are cached in `data/raw/` and every gpt-6-luna request in `data/cache/luna/`,
so a re-run replays identical output and spends nothing. `data/` is not in the repo, so a fresh
clone queries the models again. gpt-6-luna takes no temperature or seed, so expect a slightly
different compile; see FINDINGS.md for how much that matters.

## Live mode (local only, for screen-sharing)

```sh
.venv/bin/python -m pipeline.serve                         # 127.0.0.1:8000
cd web && VITE_LIVE_API=http://127.0.0.1:8000 npm run dev
```

A text box appears at the bottom of the page. Type any alert; gpt-6-luna compiles it and the Decisions
API runs it over that day's 288 snapshots in about 20 seconds. Without `VITE_LIVE_API` the box
isn't rendered, and the production build has no API calls at all.

## Deploy

The site is static. On Vercel, import this repo with **Root Directory `web`**, framework preset
**Vite**, output **`dist`**. No environment variables are needed.

## Limitations

- One day is a demonstration, not an evaluation. Cutoffs are what the compile chose; none was
  tuned on labeled data.
- The compile isn't stable across runs (the same sentence produced a 0.6 and a 0.7 cutoff), so a
  real product should freeze and display the compiled alert.
- The second question, meant to separate "scarcity approaching" from "demand record only", picked
  "scarcity approaching" during the record afternoon too. The alert's correctness rests on its
  main question.
- The prose state is a design choice; one wording fix changed a simulated run from 2 firings to 5.

Data: [Grid Status API](https://www.gridstatus.io). Dataset IDs are listed on the page and in
`pipeline/01_fetch.py`. Independent concept demo. Not affiliated with Grid Status.
