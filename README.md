# Sentence alerts for ERCOT

Grid alerts usually watch one number, such as ERCOT load above 90,000 MW. This demo tests alerts
written as a sentence instead: *"Tell me when ERCOT is actually heading toward scarcity, not just
setting demand records."* gpt-6-luna turns the sentence into two questions **once**. The OpenAI
Decisions API answers them for **every** 5-minute snapshot of the grid, returning probabilities
rather than text, and ordinary code decides whether to fire.

Two pages, both on real Grid Status API data:

- **July 22** (`/`): the story. One day, 5-minute snapshots, a threshold alert against a sentence
  alert, replayed from a saved run.
- **Try it** (`/try/`): write your own alert, pick any week from Dec 5, 2025 to Oct 8, 2026, and run
  it with your own OpenAI key, straight from the browser.

It is an independent concept demo, not affiliated with Grid Status.

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
  01_fetch.py        Grid Status API pulls → data/raw/<scenario>/*.parquet (cached)
  02_state.py        per-interval series + prose state → data/state/<scenario>.json
  03_compile.py      sentence → typed questions + rule → data/alerts/<id>.json
  04_decide.py       Decisions API over every interval → data/decisions/<id>.json
  05_compose.py      firings (sentence + threshold), explanations → web/public/demo/<id>.json
  06_whatif.py       8 GW of batteries removed → web/public/demo/whatif_<id>.json (FINDINGS only)
  07_range_fetch.py  hourly pulls for the whole range → data/raw/range/*.parquet (cached)
  08_range_state.py  hourly series + unusual days + suggested weeks → web/public/explore/ercot_hourly.json
  luna.py            the pipeline's model client (Decisions + Responses API), with a request cache
web/        (Vite + React + TypeScript, static, deployed)
  src/App.tsx              the July 22 page
  src/explore/             the Try it page; snapshot.ts, compile.ts, openai.ts and run.ts have no
                           UI code, so Node runs the same code for the saved runs
  scripts/save_runs.ts     suggested weeks' example alerts → web/public/explore/runs/<week>.json
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

## The July 22 page

- The two alerts side by side, then five moments of the day on three stacked charts (demand with
  the threshold, the model's answer with its cutoff, reserves). Captions are read from the data.
- Hover to look at any 5-minute snapshot, click to pin it, ← → to step (Shift for an hour). Under
  the charts: the model's answers, which conditions of the rule they meet, its note at an alert,
  and the exact text it read.
- Links can point at a moment: `#t=20:10`.

## The Try it page

Most weeks are uneventful, and an alert run on an ordinary week has nothing to find. So the page
starts from what happened:

- **A calendar of the whole range**, each day shaded by how many unusual signals it had: reserves
  below 5.5 GW, hub price at or above $300/MWh, non-spin at or above $100/MWh, hub price below
  -$10/MWh, demand at or above 90 GW, wind under 6 GW for the day. 71 of 308 days qualify.
  Hovering a day says what happened; clicking starts the week there.
- **Five suggested weeks**, one per kind of event, each with an example alert and a saved run, so
  the page shows a result before anyone enters a key:

  | week | event | example alert | rule met |
  |---|---|---|---|
  | Jul 19–25 | record demand | "...heading toward scarcity, not just setting demand records." | 14 evening hours; never in the record afternoon |
  | Aug 20–26 | heat wave | "...running short of reserves, not just when it's hot." | 10 hours on the 22nd, 23rd, 24th and 26th |
  | Jan 22–28 | winter price spikes | "...a price spike comes with reserves running low." | 2 hours, Jan 28 6–8 AM; not the Jan 25 spikes with 13 GW spare |
  | Feb 18–24 | negative prices | "...so much wind and solar that prices go negative." | 11 hours, 9 of them on the 24th |
  | Oct 2–8 | low wind | "...weak wind is leaving the grid tight in the evening." | 16 evening hours, Oct 5–8 |

- **A run** compiles the sentence with gpt-6-luna (the same prompts and validator as
  `03_compile.py`, ported to TypeScript), writes one snapshot per hour from the numbers (only
  that hour and earlier: "the highest in the past 30 days"), asks the Decisions API about each of
  the 168 hours, 8 at a time, and checks the rule in plain code. About 16 seconds, 82,000 input
  tokens, $0.008. A sentence compiles once per session, so trying it on other weeks reuses the
  same compiled alert.
- **The key** stays in the browser tab (session storage) and is sent only to api.openai.com, which
  allows browser requests. No server is involved. OpenAI's reply to an invalid key carries no CORS
  headers, so the page can't read it and says the key is the likely problem.
- Links can point at a week: `/try/?week=2026-08-20`.

## Regenerate

You need your own keys in `.env` (gitignored):

```
GRIDSTATUS_API_KEY=...      # free tier is enough: the full pull is ~25 requests
OPENAI_API_KEY=...          # Decisions API access for gpt-6-luna (OPEN_AI_KEY also works)
```

```sh
make setup        # uv venv + pip install, npm install
make all          # July 22 pipeline, the hourly range (07, 08), then the saved example runs
make preview      # build and serve the site locally
make check        # TS/Python rule parity, saved-run rule check, secret scan of the build
```

Grid Status pulls are cached in `data/raw/` and every gpt-6-luna request in `data/cache/luna/`
(pipeline) or `data/cache/luna-web/` (saved runs), so a re-run replays identical output and spends
nothing. The hourly range is 12 server-side resampled pulls, about 95,000 rows of the free tier's
500,000 a month; the saved runs cost about $0.05 uncached. `data/` is not in the repo, so a fresh
clone queries the models again. gpt-6-luna takes no temperature or seed, so expect a slightly
different compile; see FINDINGS.md for how much that matters.

## Deploy

The site is static, two HTML pages (`/` and `/try/`). On Vercel, import this repo with **Root
Directory `web`**, framework preset **Vite**, output **`dist`**. No environment variables are
needed: the July 22 page makes no API calls, and the Try it page uses each visitor's own key.

With the Root Directory left at `./`, Vercel sees `pyproject.toml` too and offers a multi-service
`vercel.json` with a Python service. Don't use it: the pipeline runs locally and is never
deployed, and that config would route every request to it. Set the Root Directory to `web` instead.

## Limitations

- One day is a demonstration, not an evaluation. Cutoffs are what the compile chose; none was
  tuned on labeled data.
- The compile isn't stable across runs (the same sentence produced a 0.6 and a 0.7 cutoff), so a
  real product should freeze and display the compiled alert.
- The second question, meant to separate "scarcity approaching" from "demand record only", picked
  "scarcity approaching" during the record afternoon too. The alert's correctness rests on its
  main question.
- The prose state is a design choice; one wording fix changed a simulated run from 2 firings to 5.
- The Try it page's snapshots are hourly, so events shorter than an hour show only as the hour's
  high or low. Most of April's negative prices were 5-minute dips inside hours that averaged
  above zero, which is why the suggested negative-price week is in February.
- The unusual-day flags are fixed thresholds set from this range's own distribution. They point at
  weeks worth trying; they are not labels to score an alert against.

Data: [Grid Status API](https://www.gridstatus.io). Dataset IDs are listed on the page and in
`pipeline/01_fetch.py`. Independent concept demo. Not affiliated with Grid Status.
