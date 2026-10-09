# Sentence alerts for ERCOT

Grid alerts usually watch one number, such as ERCOT load above 90,000 MW. This demo tests alerts
written as a sentence instead: *"Tell me when ERCOT is actually heading toward scarcity, not just
setting demand records."* gpt-6-luna turns the sentence into two questions **once**. The OpenAI
Decisions API answers them for **every** 5-minute snapshot of the grid, returning probabilities
rather than text, and ordinary code decides whether to fire.

Two pages, both on real Grid Status API data:

- **Overview** (`/`): the pitch. The July 22 story told in the alert form's own terms: today's
  threshold row (Select Series / Is / Value, Notification Timeout) next to a new "Describe it"
  option, and the notifications each would have sent, replayed from a saved run.
- **Create alert** (`/try/`): the alert form with "Describe it" added and a new Preview section.
  Pick any week from Dec 5, 2025 to Oct 8, 2026 and see when the description, or a threshold,
  would have notified you. Describing runs with your own OpenAI key, straight from the browser.

The UI follows Grid Status's alert form (gray canvas, white cards, the same section titles and
helper text, series named as its picker names them) because this is pitched as an enhancement to
that form, not a separate product.

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
  src/App.tsx              the Overview page (the July 22 replay)
  src/explore/             the Create alert page; snapshot.ts, compile.ts, openai.ts and run.ts have no
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

## The Overview page

- "What would you like to monitor?" shows both alerts as form sections: the threshold
  (`ERCOT Load: load`, greater than 90000, 30-minute Notification Timeout) and the description,
  with the questions and rule it compiled to. Each lists its notification times; clicking one
  jumps the replay there.
- The replay: five moments of the day on three stacked charts (load with the threshold, the
  model's answer with its cutoff, reserves). Under the charts, the notifications sent at that
  time as emails (a sentence alert's email carries gpt-6-luna's one-line reason), the model's
  answers and which conditions they meet, and the exact text it read.
- Hover to look at any 5-minute row, click to pin it, ← → to step (Shift for an hour). Links can
  point at a moment: `#t=20:10`.

## The Create alert page

The alert form's sections in order (Name your alert, What would you like to monitor?, How should
you be notified?, Notification Timeout, Alert Status, Create), plus:

- **"Describe it"** next to "Threshold" under "What would you like to monitor?". Threshold mode
  is the familiar row: a series picker named the way Grid Status names series, an operator and a
  value. Each hour is checked against its highest value for "greater than" (the 5-minute peak,
  the highest SCED price) and its lowest for "less than", so it notifies when any row in the hour
  would.
- **Preview**, the new section: a calendar and the week's charts, with both alerts tallied side
  by side. The Notification Timeout applies to both. Notifications appear as emails under the
  charts. Email, Alert Status and Create are there for the form's shape; nothing is saved or sent.
- **Start from an example** loads one of five suggested weeks with its alert name, its
  description and the threshold someone would set today.

Most weeks are uneventful, and an alert run on an ordinary week has nothing to find. So the page
starts from what happened:

- **A calendar of the whole range**, each day shaded by how many unusual signals it had: reserves
  below 5.5 GW, hub price at or above $300/MWh, non-spin at or above $100/MWh, hub price below
  -$10/MWh, demand at or above 90 GW, wind under 6 GW for the day, and a demand-weighted
  temperature at or above 100°F or at or below 32°F. 74 of 308 days qualify. Hovering a day says
  what happened; clicking starts the week there.
- **Five suggested weeks**, one per kind of event, each with an example description, a threshold
  for comparison, and a saved run, so the page shows a result before anyone enters a key:

  | week | example description | notified (no timeout) | threshold today | notified |
  |---|---|---|---|---|
  | Aug 20–26, heat wave | "...running short of reserves, not just when it's hot." | 5, all on the 3 days reserves fell to about 5.5 GW | `ERCOT Load: load` > 90000 | 19, on 6 days |
  | Jan 22–28, winter freeze | "...the freeze is actually leaving ERCOT short of reserves, not just driving up prices." | 2, Jan 28 6–7 AM; not the $938 freeze hours with 13 GW spare | hub LMP > 300 | 22, on 5 days |
  | Jul 19–25, record demand | "...heading toward scarcity, not just setting demand records." | 11, evenings Jul 19–22; never in the record afternoon | `ERCOT Load: load` > 90000 | 5, all in the record afternoon |
  | Feb 18–24, negative prices | "...so much wind and solar that prices go negative." | 25, exactly the hours with a negative average price | hub LMP < 0 | 32 |
  | Oct 2–8, low wind | "...weak wind leaves ERCOT short of reserves in the evening." | 2, Oct 5 and Oct 8 | `ERCOT Fuel Mix: wind` < 3000 | 24 |

  A threshold on the right series can come close: `ERCOT PRC: prc` < 6000 notifies in nearly the
  same 5 heat-wave hours as the description. The description's advantage is not having to know
  which series and number mean "short".

- **A run** compiles the sentence with gpt-6-luna (the same prompts and validator as
  `03_compile.py`, ported to TypeScript), writes one snapshot per hour from the numbers (temperature,
  demand, solar, wind, batteries, prices, reserves; only that hour and earlier, as in "the highest
  in the past 30 days"), asks the Decisions API about each of the 168 hours, 8 at a time, and checks
  the rule in plain code. About 16 seconds and 90,000 to 110,000 input tokens, about a cent. A
  sentence compiles once per session, so trying it on other weeks reuses the same compiled alert.
- **Temperature** is observed, not forecast: ERCOT's daily weather-zone file starts three days
  back, and a past hour's value stops changing once the day is over, so the latest published
  value is the observed one. The snapshot gives the ERCOT average weighted by each zone's share of
  demand, plus Dallas-Fort Worth and Houston.
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
nothing. The hourly range is 14 pulls (resampled server-side where the source is finer than
hourly), about 103,000 rows of the free tier's 500,000 a month; the saved runs cost about $0.05
uncached. `data/` is not in the repo, so a fresh
clone queries the models again. gpt-6-luna takes no temperature or seed, so expect a slightly
different compile; see FINDINGS.md for how much that matters.

## Deploy

The site is static, two HTML pages (`/` and `/try/`). On Vercel, import this repo with **Root
Directory `web`**, framework preset **Vite**, output **`dist`**. No environment variables are
needed: the Overview page makes no API calls, and the Create alert page uses each visitor's own key.

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
- The Create alert page's snapshots are hourly, so events shorter than an hour show only as the hour's
  high or low. Most of April's negative prices were 5-minute dips inside hours that averaged
  above zero, which is why the suggested negative-price week is in February.
- The unusual-day flags are fixed thresholds set from this range's own distribution. They point at
  weeks worth trying; they are not labels to score an alert against.

Data: [Grid Status API](https://www.gridstatus.io). Dataset IDs are listed on the page and in
`pipeline/01_fetch.py`. Independent concept demo. Not affiliated with Grid Status.
