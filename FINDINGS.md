# Findings

What happened when an alert written as a sentence ran against a real ERCOT day (July 22, 2026),
compared with the threshold alert you'd write today. All numbers below come from the shipped run
in `web/public/demo/`. Every gpt-6-luna request and response is cached in `data/cache/luna/`, so
`make all` reproduces this run byte for byte. That was checked by diffing two full runs.

**Models.** gpt-6-luna does everything. The OpenAI Decisions API (`POST /v1/decisions`) answers
the questions on every 5-minute snapshot: 288 snapshots, one request each, two questions per
request, 576 answers in all. The Responses API (JSON mode) compiles the alert once and writes the
explanations. Decisions cost $0.012 in input tokens for the day.

**Latency** is the HTTPS round trip from a US laptop to api.openai.com, with 6 requests in
flight: median 154 ms, p95 841 ms, max 1,471 ms. In an earlier run of the same requests, the
median was 130 ms and the p95 211 ms. Treat the tail as network and service variance, not model
cost.

## Result

| | alert | fired |
|---|---|---|
| Threshold | `ERCOT load > 90,000 MW` | **8** times, 2:55 to 6:25 PM |
| Sentence | "Tell me when ERCOT is actually heading toward scarcity, not just setting demand records." | **4** times, 8:10 to 10:25 PM |

Both alerts use a 30-minute re-fire cooldown, like Grid Status's Notification Timeout.

## Where the sentence alert did better

- **It ignored the record.** All 8 threshold firings came while operating reserves (PRC) were
  16.5 to 17.7 GW, the hub price was under $82/MWh, and non-spin was about $0. The sentence
  alert's main answer, P(heading toward scarcity), had a median of 0.18 between 2 and 6 PM,
  peaked at 0.34, and was 0.14 to 0.26 at the 8 threshold firings.
- **It fired when the grid actually tightened.** Its 4 firings (8:10, 9:20, 9:50 and 10:25 PM)
  line up with reserves falling from 9.2 to 6.6 GW, non-spin rising to $187/MWh and the hub
  hitting $378 at 10:05 PM. That's the window the Grid Status post describes, when battery
  discharge came off its peak around 10 PM.
- **The explanations are grounded.** All 12 explanations (4 for firings, 8 for threshold firings
  the sentence alert declined) passed both automatic checks on the first try: every number
  appears in the snapshot text, and none of them talks about the model instead of the grid.

## Where it did worse

- **It's borderline.** The 4 firings sit at P = 0.70 to 0.73 against a 0.7 cutoff. From 8:15 to
  9:15 PM, while reserves were already dropping, P hovered at 0.6x and the alert stayed silent.
  Moving the cutoff by 0.05 changes the story.
- **The compile is not stable.** gpt-6-luna doesn't accept `temperature` or `seed`, and two
  compiles of the same sentence gave different rules:
  - `heading_toward_scarcity >= 0.6 && current_condition.'heading toward scarcity' >= 0.6` fired
    7 times, including 7:00 AM (reserves 8.0 GW but hub $55 and non-spin $1, arguably a false
    alarm) and 6:50 PM (reserves still 16.2 GW).
  - `scarcity_approaching >= 0.7 && ercot_state.'scarcity approaching' >= 0.6` is the shipped
    run, with 4 firings.

  Same sentence, same data, different alert. A product would need to freeze the compiled alert
  and show it to the user, as the page does, and not recompile silently.
- **The contrast question failed at its one job.** "Which best describes ERCOT's current state?"
  was meant to separate "scarcity approaching" from "demand record only". At all 8 threshold
  firings in the record afternoon, it picked "scarcity approaching" (0.52 to 1.00). It also jumps
  between about 0.1 and 1.0 across the day. The rule held only because it also requires the main
  question, which stayed low. The 7:00 AM spike in the main question (0.63) stopped just short of
  the 0.7 cutoff.
- **Refusals.** The shipped run had 0 refusals. In live mode, though, the question "Is physical
  responsive capability, or operating reserves, falling?" was refused on 131 of 288 snapshots,
  with no reason given. The rule treats a refusal as "not firing". A product would need to
  surface refusals; live mode now does.
- **Wording moves answers.** In the what-if, the first simulated snapshot text said "Net load
  (demand minus wind and solar)" after adding the removed battery output to it. That label was
  wrong. Fixing the label alone changed the simulated run from 2 firings to 5.

## What-if: 8 GW of batteries offline

Simulated by cutting battery discharge by up to 8 GW at every interval and adding the removed
amount to net load. **Prices and reserves stay real**, so this tests how the model reads those
two numbers, not what ERCOT would have done. The simulated alert fired 5 times (6:45, 8:20, 9:15,
9:50 and 10:20 PM) vs. 4 for the real run. The hourly mean of P(scarcity) rose from 0.30 to 0.45
at 6 PM and from 0.35 to 0.46 at 7 PM, then matched the real run after 9 PM. Takeaway: the model
leans on prices and reserves much more than on battery and net-load numbers. That's reasonable,
but it means a battery-shortfall scenario needs price and reserve consequences to register.

## Data checks against the Grid Status blog post

Source: [ERCOT's record, July 2026](https://blog.gridstatus.io/ercot-record-july-2026). Nothing
was adjusted to match.

| claim | ours | dataset | verdict |
|---|---|---|---|
| Load peak 91,308 MW (prev day 87,533) | 91,308 MW at 4:55 PM; 87,533 on Jul 21 | `ercot_load` | match |
| Net-load peak 75,733 MW around 8 PM | 75,733 MW at 8:20 PM (5-min, load − solar − wind) | `ercot_load`, `ercot_fuel_mix` | match. The hourly `ercot_net_load` peak is 75,289 MW at 8 PM. |
| Real-time price peak $378/MWh | $378.50 hub average at 10:05 PM | `ercot_lmp_by_settlement_point` (HB_HUBAVG, per SCED run) | match. The 15-min settlement price peaks at $349. |
| Real time below day-ahead through the net-load peak | below in 43 of 48 intervals 5–9 PM, including the 8:20 PM peak; above 6:35–6:55 PM | same + `ercot_spp_day_ahead_hourly` | mostly matches |
| NSPIN up to $325 as battery discharge fell off around 10 PM | NSPIN $325.59 at 10:05 PM; discharge hourly mean 11.4 GW at 8 PM → 2.5 GW at 10 PM | `ercot_mcpc_sced`, `ercot_energy_storage_resources` | match |

Data notes:
- `ercot_load_forecast` keeps one forecast per interval, and on Jul 22 most rows carry a vintage
  published *after* the day ended. We used `ercot_load_forecast_by_forecast_zone`
  (`system_total`), taking the latest hourly vintage published before each interval, so the
  forecast has no lookahead.
- Reserves (PRC) come from `ercot_prc`, published every ~10 s and averaged to 5 minutes.
- One interval is missing solar and wind. It's left blank, not interpolated.
- The snapshot text at each interval uses only data at or before that interval ("highest so far
  today", not "highest of the day").
- Spot check: for 5 intervals, every number in the snapshot text was recomputed straight from the
  raw parquet pulls. All matched.

## Models tried before gpt-6-luna

The first version used a local, untuned decision model (Laya) for answers and a local 7B LLM for
compiling and explanations. Laya's P(scarcity) had the right shape, peaking at 0.585 at 10:05 PM,
but never reached the compiled cutoff. The 7B LLM needed five rounds of validator feedback to
compile the sentence without inverting the contrast. We switched to gpt-6-luna for both roles;
none of that code or output remains.

## Limitations

- One day is a demonstration, not an evaluation. No cutoff was tuned on labeled data; the cutoffs
  are whatever the compile chose.
- The page replays a precomputed run. Live mode (`pipeline/serve.py`) is local only.
- Explanations are checked for invented numbers and for talking about the model, not for
  reasoning quality.
