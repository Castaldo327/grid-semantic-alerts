# Findings

What happened when a sentence-defined alert ran against two real ERCOT days, compared with the
threshold alert you'd write today. All numbers below come from the shipped run in
`web/public/demo/`. Every gpt-6-luna request and response is cached in `data/cache/luna/`, so
`make all` reproduces this run byte for byte. That was checked by diffing two full runs.

**Models.** gpt-6-luna does everything: the OpenAI Decisions API (`POST /v1/decisions`) answers
the typed questions on every 5-minute snapshot, and the Responses API (JSON mode) compiles each
alert once and writes the explanations. There are 288 snapshots per day, one request per
snapshot, and two questions per alert, so each alert took 576 decisions. Cost was $0.028 in input
tokens for both days together.

**Latency** is the HTTPS round trip from a US laptop to api.openai.com, with 6 requests in flight:

| alert | median | p95 | max |
|---|---|---|---|
| A, Jul 22 2026 | 154 ms | 841 ms | 1,471 ms |
| B, Feb 19 2025 | 267 ms | 841 ms | 1,481 ms |

In an earlier run of the same requests, the median was 130 ms and the p95 211 ms. Treat the
tail as network and service variance, not model cost.

## Scorecard

| | threshold alert | semantic alert |
|---|---|---|
| **A: Record load, no scarcity** (Jul 22, 2026) | `load > 90,000 MW` fired **8** times, 2:55 to 6:25 PM | fired **4** times, 8:10 to 10:25 PM |
| **B: Local spike, not system-wide** (Feb 19, 2025) | `RHESS2_ESS1 > $1,000/MWh` fired **32** times | fired **0** times |

Both alerts use a 30-minute re-fire cooldown, like Grid Status's Notification Timeout.

## Where the semantic alert did better

- **A: it ignored the record.** All 8 threshold firings came while operating reserves (PRC)
  were 16.5 to 17.7 GW, the hub price was under $82/MWh, and non-spin was about $0. On the
  semantic alert, P(heading toward scarcity) had a median of 0.18 between 2 and 6 PM, peaked at
  0.34, and was 0.14 to 0.26 at the 8 threshold firings. The main question did this on its own;
  the contrast question did not help (see below).
- **A: it fired when the grid actually tightened.** Its 4 firings (8:10, 9:20, 9:50 and
  10:25 PM) line up with reserves falling from 9.2 to 6.6 GW, non-spin rising to $187/MWh and
  the hub hitting $378 at 10:05 PM. That's the window the Grid Status post describes, when
  battery discharge came off its peak around 10 PM.
- **B: it declined all 32 threshold firings.** Its main question ("Are prices spiking because the
  whole ERCOT grid is short of supply?") never went above 0.18. That includes the evening, when
  the hub reached $469/MWh, though reserves never fell below 8.2 GW. For each declined firing,
  gpt-6-luna wrote a note naming the binding constraint, for example `1680__A` on RRWES–GEORSO
  with 368 MW of flow against a 266 MW limit. All 44 explanations passed both automatic checks:
  every number appears in the state prose, and none of them talks about the model.

## Where it did worse, or got lucky

- **A is borderline.** The 4 firings sit at P = 0.70 to 0.73 against a 0.7 cutoff. From 8:15 to
  9:15 PM, while reserves were already dropping, P hovered at 0.6x and the alert stayed silent.
  Moving the cutoff by 0.05 changes the story.
- **The compile is not stable.** gpt-6-luna doesn't accept `temperature` or `seed`, and two
  compiles of sentence A gave different rules:
  - `heading_toward_scarcity >= 0.6 && current_condition.'heading toward scarcity' >= 0.6` fired
    7 times, including 7:00 AM (reserves 8.0 GW but hub $55 and non-spin $1, arguably a false
    alarm) and 6:50 PM (reserves still 16.2 GW).
  - `scarcity_approaching >= 0.7 && ercot_state.'scarcity approaching' >= 0.6` is the shipped
    run, with 4 firings.

  Same sentence, same data, different alert. A product would need to freeze the compiled alert
  and show it to the user, as this page does, and not recompile silently.
- **B's contrast question doesn't discriminate.** "What best explains the current price spike?"
  answered "one-area congestion" at all 288 intervals, including the 65 when the node was under
  $100 and nothing was spiking. Constraints really were binding statewide all day, so the answer
  is defensible, but the alert's correctness on B rests on the main question, not on the
  contrast.
- **A's contrast question failed at its one job.** "Which best describes ERCOT's current state?"
  was meant to separate "scarcity approaching" from "demand record only". At all 8 threshold
  firings in the record afternoon, it picked "scarcity approaching" (0.52 to 1.00). It also jumps
  between about 0.1 and 1.0 across the day. The rule held only because it also requires the main
  question, which stayed low. The 7:00 AM spike in the main question (0.63) stopped just short of
  the 0.7 cutoff.
- **Refusals.** The shipped runs had 0 refusals. In live mode, though, the predicate "Is physical
  responsive capability, or operating reserves, falling?" was refused on 131 of 288 snapshots,
  with no reason given. The rule treats a refusal as "not firing". A product would need to
  surface refusals; this page's live mode now does.
- **Wording moves answers.** In the what-if, the first simulated prose said "Net load (demand
  minus wind and solar)" after adding the removed battery output to it. That label was wrong.
  Fixing the label alone changed the simulated run from 2 firings to 5.

## What-if: 8 GW of batteries offline on Jul 22

Simulated by cutting battery discharge by up to 8 GW at every interval and adding the removed
amount to net load. **Prices and reserves stay real**, so this tests how the model reads those
two numbers, not what ERCOT would have done. The simulated alert fired 5 times (6:45, 8:20, 9:15,
9:50 and 10:20 PM) vs. 4 for the real run. The hourly mean of P(scarcity) rose from 0.30 to 0.45
at 6 PM and from 0.35 to 0.46 at 7 PM, then matched the real run after 9 PM. Takeaway: the model
leans on prices and reserves much more than on battery and net-load numbers. That's reasonable,
but it means a battery-shortfall scenario needs price and reserve consequences to register.

## Data checks against the Grid Status blog posts

Nothing was adjusted to match. Sources:
[ERCOT's record, July 2026](https://blog.gridstatus.io/ercot-record-july-2026) and
[Exploring extreme prices in ERCOT](https://blog.gridstatus.io/exploring-extreme-prices-in-ercot-with-grid-status).

| claim | ours | dataset | verdict |
|---|---|---|---|
| Load peak 91,308 MW (prev day 87,533) | 91,308 MW at 4:55 PM; 87,533 on Jul 21 | `ercot_load` | match |
| Net-load peak 75,733 MW around 8 PM | 75,733 MW at 8:20 PM (5-min, load − solar − wind) | `ercot_load`, `ercot_fuel_mix` | match. The hourly `ercot_net_load` peak is 75,289 MW at 8 PM. |
| Real-time price peak $378/MWh | $378.50 hub average at 10:05 PM | `ercot_lmp_by_settlement_point` (HB_HUBAVG, per SCED run) | match. The 15-min settlement price peaks at $349. |
| Real time below day-ahead through the net-load peak | below in 43 of 48 intervals 5–9 PM, including the 8:20 PM peak; above 6:35–6:55 PM | same + `ercot_spp_day_ahead_hourly` | mostly matches |
| NSPIN up to $325 as battery discharge fell off around 10 PM | NSPIN $325.59 at 10:05 PM; discharge hourly mean 11.4 GW at 8 PM → 2.5 GW at 10 PM | `ercot_mcpc_sced`, `ercot_energy_storage_resources` | match |
| Rabbit Hill node near $30,000/MWh | $28,401 at 8:10 AM (SCED); $28,340 15-min settlement | `ercot_lmp_by_settlement_point` (RHESS2_ESS1) | match |
| Far above the $5,000 offer cap | above $5,000 in 113 of 288 intervals | same | consistent |
| Constraints around Austin and GEORSO | `1680__A` on RRWES–GEORSO 138 kV binding most of the day, at up to $3,500 | `ercot_shadow_prices_sced` | consistent |
| Hub prices unremarkable | hub average $162 at the node's peak; daily high $469 (evening) | `ercot_lmp_by_settlement_point` (HB_HUBAVG) | consistent. The evening hub rise is real and is mentioned on the page. |

Data notes:
- `ercot_load_forecast` keeps one forecast per interval, and on Jul 22 most rows carry a vintage
  published *after* the day ended. We used `ercot_load_forecast_by_forecast_zone`
  (`system_total`), taking the latest hourly vintage published before each interval, so the
  forecast has no lookahead.
- PRC: `ercot_real_time_adders_and_reserves` is empty after RTC+B (2025-12-05), so Jul 22 uses
  `ercot_prc` (published every ~10 s, averaged to 5 minutes).
- One interval on Jul 22 is missing solar and wind. It's left blank, not interpolated.
- The "near node" GEORSO link comes from the blog post. Without shift factors, the data alone
  can't say which constraints set the Rabbit Hill price.
- Prose at each interval uses only data at or before that interval: "highest so far today", not
  "highest of the day".
- Spot check: for 5 intervals per scenario, every number in the prose was recomputed straight
  from the raw parquet pulls. All 10 matched.

## Models tried before gpt-6-luna

The first version used a local, untuned decision model (Laya) for answers and a local 7B LLM for
compiling and explanations.

- Laya's P(scarcity) had the right shape on Jul 22, peaking at 0.585 at 10:05 PM, but never
  reached the compiled cutoff.
- On Feb 19 its "is the grid short?" probability tracked the node price (Spearman ρ 0.51), not
  reserves (ρ −0.08). That's the exact confusion the alert exists to avoid.
- The 7B LLM needed five rounds of validator feedback to compile sentence A without inverting the
  contrast.

We switched to gpt-6-luna for both roles; none of that code or output remains.

## Limitations

- Two days are a demo, not an evaluation. No cutoff was tuned on labeled data, and the cutoffs
  are whatever the compile chose.
- The page replays a precomputed run. Live mode (`pipeline/serve.py`) is local only.
- Explanations are checked for invented numbers and talk about the model, not for reasoning
  quality.
