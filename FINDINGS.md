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

- **It's borderline and jumpy.** The 4 firings sit at P = 0.70 to 0.73 against a 0.7 cutoff.
  Between 8:20 and 9:10 PM, with reserves holding near 9 GW, P fell back to 0.21 to 0.58 before
  climbing again. With the same answers, a 0.6 cutoff fires 5 times (adding a 7:00 AM alarm), 0.75
  fires twice, and 0.8 fires once (10:00 PM).
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
- **Refusals.** The shipped run had 0 refusals. In an earlier local live mode, though, the question
  "Is physical responsive capability, or operating reserves, falling?" was refused on 131 of 288
  snapshots, with no reason given. The rule treats a refusal as "not firing". A product would need
  to surface refusals; the Try it page reports them (see the October week below).
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

## Five more weeks, hourly (the Try it page)

The Try it page runs alerts on hourly snapshots of any week from Dec 5, 2025 to Oct 8, 2026. Each
of its five suggested weeks has a saved run of an example alert, made with the page's own code
(`web/scripts/save_runs.ts`, cached in `data/cache/luna-web/`): 168 Decisions API calls per week,
79,000 to 91,000 input tokens ($0.008 to $0.009), median 168 to 198 ms. Each hourly snapshot gives
the hour's average and its extreme (price high and low, reserve low), so a short spike still
shows. Each alert was compiled fresh, so these are not the July 22 page's compiled alert.

| week | example alert | rule met |
|---|---|---|
| Jul 19–25 | "Tell me when ERCOT is actually heading toward scarcity, not just setting demand records." | 14 hours: 7–9 PM Jul 19 and 20, 7–11 PM Jul 21, 6–11 PM Jul 22, 7–8 PM Jul 25 |
| Aug 20–26 | "Warn me when the grid is running short of reserves, not just when it's hot." | 10 hours: 10 PM–12 AM Aug 22, 7–10 PM Aug 23, 7–8 PM Aug 24, 7–11 PM Aug 26 |
| Jan 22–28 | "Tell me when a price spike comes with reserves running low." | 2 hours: 6–8 AM Jan 28 |
| Feb 18–24 | "Let me know when there's so much wind and solar that prices go negative." | 11 hours, all with a negative hourly average; 9 on Feb 24 |
| Oct 2–8 | "Warn me when weak wind is leaving the grid tight in the evening." | 16 hours, in the evenings of Oct 5 to 8 |

- **The record afternoon stayed quiet again.** Across the week, P(scarcity) was 0.13 to 0.68
  between 2 and 6 PM. At 4 PM on July 22 (91.3 GW peak, reserves 17.4 GW) it was 0.26. Unlike the
  5-minute run, the contrast question leaned the right way there: "setting demand records" 0.42,
  "heading toward scarcity" 0.36.
- **It also alerted on evenings the July 22 page doesn't cover.** Jul 21 is defensible (reserves
  down to 6.9 GW, non-spin $111). Jul 19 is closer to a false alarm: reserves never went below
  9.0 GW and the hub stayed under $107.
- **January: a score question did what the contrast question couldn't.** The main question,
  "Is the hub real-time price unusually high while ERCOT operating reserves are low?", passed 0.7
  in 66 of 168 hours, including Jan 25 at 6 PM ($938 with 13.8 GW of reserves to spare, P = 0.95).
  The second question, how scarce reserves are on a 0-3 scale, put that hour at 0.54 and Jan 28 at
  6 and 7 AM (reserves 6.2 and 5.7 GW, hub up to $1,350) at 1.96 and 2.03, so only the real
  shortage alerted. A first wording, "...means the grid is actually short, not just that power is
  expensive", never fired: its main question passed 0.7 in 4 hours, including Jan 28 at 6 and 7 AM
  (0.75 and 0.72), and at all four the contrast question chose "expensive power without shortage"
  at 0.99 or more. That's the July 22 contrast-question failure again, and it decided the outcome
  this time.
- **Hourly snapshots hide short events.** April has the deepest negative prices in the range (down
  to -$97/MWh on Apr 14), but they were 5-minute dips inside hours that averaged above zero. On
  Apr 14–20 the negative-price alert fired once. Its second question, "Did prices fall below $0
  during this hour?", answered 1.00 at all six hours with a sub-zero low, but the main question
  read the hourly average. February's wind kept the average below zero for 25 hours, and the alert
  met its rule in 11 of them.
- **Refusals came from a question that didn't apply.** In October, the main question, "Is weak wind
  leaving ERCOT's grid tight during this evening hour?", was declined 31 times, all between 4 AM
  and 2 PM. The rule counts those hours as not met, which is the right outcome here. The page
  reports the count.

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
- The July 22 page replays a precomputed run. The Try it page runs live with a visitor's own key;
  its five saved runs are single samples, and gpt-6-luna doesn't repeat itself exactly.
- The unusual-day flags on the Try it page are fixed thresholds. They point at weeks worth trying;
  they are not labels to score an alert against.
- Explanations are checked for invented numbers and for talking about the model, not for
  reasoning quality.
