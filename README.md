# Sentence alerts for ERCOT

**Live demo: [grid-semantic-alerts.vercel.app](https://grid-semantic-alerts.vercel.app/)**

Grid Status alerts check one series against one value: true or false. Customers care about
situations, and a situation has no single line. This demo lets you write an alert as a sentence:

> *"Warn me when the freeze is actually leaving ERCOT short of reserves, not just driving up prices."*

gpt-6-luna compiles the sentence into questions once. The OpenAI Decisions API scores every new row
of Grid Status data with probabilities (a degree of truth, as in fuzzy logic), and plain code
decides whether to notify.

An independent concept demo, not affiliated with Grid Status.

## The demo

- **Overview** (`/`): the Jan 22–28, 2026 winter freeze, checked by the four threshold alerts it
  takes today and by the sentence, with the hours where they disagree.
- **Create alert** (`/try/`): Grid Status's alert form with a new "Describe it" option and a
  Preview. Try any week from Dec 5, 2025 to Oct 8, 2026. Your own sentences run with your own
  OpenAI key, in the browser only.

## Result

| alert | notifications, Jan 22–28 |
|---|---|
| Dallas ≤ 32°F ("the freeze") | 91 |
| Reserves < 5,500 MW ("short of reserves") | 0: reserves bottomed out at 5.7 GW |
| Non-spin ≥ $100 ("short of reserves") | 2: Jan 28, 7–8 AM |
| Hub price > $300 ("driving up prices") | 22 |
| **The sentence** | **2: Jan 28, 6–7 AM** |

The thresholds sent 115 notifications. The sentence sent 2, during the week's one real shortage,
an hour before any reserves threshold. Other weeks, the July 22 study and what didn't work are in
[FINDINGS.md](FINDINGS.md).

## How it works

```
 "Warn me when the freeze is actually leaving ERCOT short of reserves, not just driving up prices."
    │  once: gpt-6-luna (Responses API), validated and retried         web/src/explore/compile.ts
    ▼
 probability  freeze_short_reserves  "Is the freeze leaving ERCOT short of reserves right now?"
 choice       freeze_effect          short reserves | higher prices only | nothing unusual
 rule         freeze_short_reserves >= 0.7 && freeze_effect.'short reserves' >= 0.7
    │  every row: gpt-6-luna (Decisions API) on a prose snapshot       web/src/explore/run.ts
    ▼
 { freeze_short_reserves: 0.80, freeze_effect: { short reserves: 1.00, … } }
    │  plain code, no model: rule + Notification Timeout              web/src/rule.ts
    ▼
 notify / don't notify
```

A week of hourly checks takes about 16 seconds and costs about a cent.

## Repo

```
pipeline/   Python, runs locally: Grid Status API pulls, prose snapshots, compile, decisions (01–08)
web/        Vite + React + TypeScript, static, deployed
  src/App.tsx            Overview
  src/explore/           Create alert; compile, snapshot and run code has no UI, so Node reuses it
  scripts/save_runs.ts   saved runs for the suggested weeks
```

## Run it locally

Put your keys in `.env` (gitignored):

```
GRIDSTATUS_API_KEY=...   # the free tier is enough
OPENAI_API_KEY=...       # Decisions API access for gpt-6-luna
```

```sh
make setup     # Python venv and npm install
make all       # regenerate data and saved runs, reusing cached pulls and model responses
make preview   # build and serve locally
make check     # rule checks and a secret scan of the build
```

`data/` isn't in the repo, so a fresh clone calls both APIs again.

## Deploy

Vercel, from GitHub: Root Directory `web`, preset Vite, output `dist`, no environment variables.
If the root is left at `./`, Vercel offers a multi-service `vercel.json`; don't use it, since the
Python pipeline is never deployed.

## Limitations

- A week of data is a demonstration, not an evaluation. Cutoffs come from the compile, not from
  tuning on labeled data.
- Compiles vary between runs (gpt-6-luna takes no temperature or seed), so a product should freeze
  and show the compiled alert.
- Snapshots are hourly, so events shorter than an hour show only as the hour's high or low.
- The wording of the prose snapshot moves the answers.

Data: [Grid Status API](https://www.gridstatus.io).
