# Sentence alerts for ERCOT

Grid Status alerts are Boolean: each one checks one series against one line, true or false.
Customers think in situations, and a situation has no line. This demo makes one into a single alert:
*"Warn me when the freeze is actually leaving ERCOT short of reserves, not just driving up prices."*
gpt-6-luna compiles the sentence into questions **once**. The OpenAI Decisions API grades **every**
new row with probabilities rather than text, giving the situation a degree of truth the way fuzzy
logic does, and ordinary code decides whether to notify.

Two pages, both on real Grid Status API data:

- **Overview** (`/`): the pitch, written for an engineering audience. The winter freeze of
  Jan 22–28, 2026, checked two ways: the four threshold alerts it would take today, one per part of
  the sentence (Boolean, 115 notifications), and the sentence itself (fuzzy, 2), with the hours where
  they part ways. It replays a saved run.
- **Create alert** (`/try/`): the alert form with "Describe it" added, and a Preview beside it.
  Pick any week from Dec 5, 2025 to Oct 8, 2026 and see when a description and a threshold would
  have notified you. Your own description runs with your own OpenAI key, straight from the browser.

The UI follows Grid Status's alert form (gray canvas, white cards, the same section titles and
helper text, series named as its picker names them) because this is pitched as an enhancement to
that form, not a separate product.

It is an independent concept demo, not affiliated with Grid Status.

**Live demo:** [grid-semantic-alerts.vercel.app](https://grid-semantic-alerts.vercel.app) · **Results, including failures:** [FINDINGS.md](FINDINGS.md)

## How it works

```
 "Warn me when the freeze is actually leaving ERCOT short of reserves, not just driving up prices."
        │
        ▼  once per alert         gpt-6-luna, Responses API (JSON)        web/src/explore/compile.ts
 ┌──────────────────────────────────────────────────────────────────┐
 │ probability freeze_short_reserves  "Is the freeze leaving ERCOT  │  validated, rejected and
 │                                     short of reserves right now?"│  retried (≤3) if it
 │ choice      freeze_effect  [short reserves | higher prices only  │  doesn't fit, such as a
 │                             | nothing unusual]                   │  rule that doesn't rule
 │ rule  freeze_short_reserves >= 0.7                               │  out "just driving up
 │         && freeze_effect.'short reserves' >= 0.7                 │  prices"
 └──────────────────────────────────────────────────────────────────┘
        │
        ▼  every new row          gpt-6-luna, Decisions API               web/src/explore/run.ts
 grid snapshot as short prose ──► { freeze_short_reserves: P(yes)=0.80,
 (Grid Status API data, only        freeze_effect: {short reserves: 1.00, ...} }
  what was known at that hour)
        │
        ▼  plain code, no model   rule + Notification Timeout             web/src/rule.ts
 notify / don't notify
```

The Python pipeline does the same with 5-minute rows for July 22, 2026, plus a one-line
explanation on each notification; that study is in [FINDINGS.md](FINDINGS.md).

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
  src/App.tsx              the Overview page (one sentence vs. the threshold alerts it would take)
  src/explore/             the Create alert page; featured.ts (the Overview's example and its threshold
                           alerts), snapshot.ts, compile.ts, openai.ts and run.ts have no UI code, so
                           Node runs the same code for the saved runs
  scripts/save_runs.ts     suggested weeks' example alerts → web/public/explore/runs/<week>.json
```

Both pages recompute every notification in the browser from saved answers (`web/src/rule.ts`) and
show whether they match. `npm run check-rules` checks the pipeline's July 22 run and every saved
run the same way.

## The test week

Jan 22–28, 2026: a hard freeze from the 24th to the 27th (down to 19°F demand-weighted, 13°F in
Dallas) sent the hub price to $938/MWh on the 25th with about 14 GW of reserves to spare. The
shortage came on the morning of the 28th: reserves fell to 5.7 GW and the price hit $1,350.

| alert | notifications |
|---|---|
| Dallas ≤ 32°F, for "the freeze" | 91 |
| Reserves < 5,500 MW, for "short of reserves" | 0: reserves never fell below 5.7 GW |
| Non-spin ≥ $100, for "short of reserves" | 2: Wed 28, 7 and 8 AM |
| Hub price > $300, for "driving up prices" | 22, on 5 days |
| The sentence | 2: Wed 28, 6 and 7 AM |

The sentence's first notification came an hour before any reserves alert. At 6,000 MW instead of
5,500, the reserves alert would have caught one hour (7 AM); at 5,500 it caught none. The
highest-priced hour the sentence let pass ($938 on Sun 25 at 6 PM, with 14.1 GW of reserves) scored
38%, and most hours sit near 12%.

## The Overview page

- The thesis, then the situation: the freeze sentence and who would write it, a demand-response
  aggregator that cuts load only in a real shortage.
- One card shows the week both ways: the four threshold alerts as rows of true and false
  (classical, Boolean logic) with 115 notifications, above the sentence's degree of truth for every
  hour (fuzzy logic), its 70% cutoff and 2 notifications.
- Three hours where they part ways, found in the data: the $938 hour that's expensive but not
  short, the 6 AM notification that comes before any reserves alert, and the shortage itself. Under
  them, the hour in detail: the four checks with their values, and the sentence's email with the
  model's answers and the text it read.
- How it works, with the run's cost and speed, and "Why I built this", three points in the
  author's voice.
- Hover to look at any hour, click (or Enter on a notification dot) to pin it, ← → to step
  (Shift for a day).

## The Create alert page

The alert form on the left (Name your alert, What would you like to monitor?, Notification
Timeout, then How should you be notified?, Alert Status, Create) and the new Preview on the right,
so a change shows its effect without scrolling. On a phone the Preview sits between the monitoring
fields and the notification settings. Added to the form:

- **"Describe it"** next to "Threshold" under "What would you like to monitor?". Threshold mode
  is the familiar row: a series picker named the way Grid Status names series, an operator and a
  value. Each hour is checked against its highest value for "greater than" (the 5-minute peak,
  the highest SCED price) and its lowest for "less than", so it notifies when any row in the hour
  would.
- **Preview**, new: a calendar, then the chosen week with both alerts at once, each with its
  notifications (back-to-back hourly ones draw as one pill), whichever one the form is set to.
  Each day is headed with what happened that day, and the grid data underneath (reserves, hub
  price, demand, temperature, wind) is there to judge each notification. Below, one hour in
  detail: each alert's email or why it stayed quiet. ‹ › steps between notifications, a day
  heading jumps to that day, ← → move an hour. The Notification Timeout applies to both alerts.
  Email, Alert Status and Create are there for the form's shape; nothing is saved or sent.
- **Your key and a Preview button** sit under the description, marked demo only, with what the
  preview costs. A description shows nothing until it's previewed: its chart says what to do
  next. An unchanged example shows its saved run (Preview reruns it with your key); change a word
  and it's empty again.
- **Start from an example**, above both columns: the winter freeze first (the Overview's alert),
  then the other four suggested weeks, each with its alert name, its description and the threshold
  someone would set today. **Write your own** clears the
  description and puts the cursor in it, keeping the week and the threshold for comparison.

Most weeks are uneventful, and an alert run on an ordinary week has nothing to find. So the page
starts from what happened:

- **A calendar of the whole range**, each day shaded by how many unusual signals it had: reserves
  below 5.5 GW, hub price at or above $300/MWh, non-spin at or above $100/MWh, hub price below
  -$10/MWh, demand at or above 90 GW, wind under 6 GW for the day, and a demand-weighted
  temperature at or above 100°F or at or below 32°F. 74 of 308 days qualify. Hovering a day shows
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
make all          # July 22 pipeline, the hourly range (07, 08), then the saved runs
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

- One week (and one day in the pipeline) is a demonstration, not an evaluation. Cutoffs are what
  the compile chose; none was tuned on labeled data.
- The compile isn't stable across runs (the same sentence produced a 0.6 and a 0.7 cutoff), so a
  real product should freeze and display the compiled alert.
- On July 22, the second question, meant to separate "scarcity approaching" from "demand record only", picked
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
