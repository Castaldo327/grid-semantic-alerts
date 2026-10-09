"""Hourly ERCOT series for the week explorer (web/try/), cached under data/raw/range/.

Grid Status resamples server-side to one hour, so the whole range (Dec 5, 2025 to Oct 8, 2026, plus
30 days of context before it) is about 8,100 rows per pull and 12 pulls in all. The free tier
allows 500,000 rows and 250 requests a month. Mean, min and max are separate pulls: the hourly
snapshot reports the hour's average and its extreme, so a 10-minute price spike or reserve dip
still shows up.

  ercot_load                      demand: hourly mean and 5-minute peak
  ercot_fuel_mix                  solar and wind: hourly mean
  ercot_energy_storage_resources  battery discharging and charging: hourly mean
  ercot_lmp_by_settlement_point   hub (HB_HUBAVG) real-time price per SCED run: mean, max, min
  ercot_spp_day_ahead_hourly      hub day-ahead price (already hourly)
  ercot_mcpc_sced                 non-spinning reserve (NSPIN) real-time price: mean, max
  ercot_prc                       physical responsive capability (operating reserves): mean, min

The load forecast is left out: pulling every hourly vintage for ten months (to avoid lookahead,
see 01_fetch.py) would cost more than the rest combined.
"""

from pipeline.common import RANGE, CachedGridStatus, log

HUB = "HB_HUBAVG"

# label: (dataset, resample function or None, extra query)
PULLS = {
    "load_mean": ("ercot_load", "mean", {}),
    "load_max": ("ercot_load", "max", {}),
    "fuel_mix_mean": ("ercot_fuel_mix", "mean", {"columns": ["interval_start_utc", "interval_end_utc", "solar", "wind"]}),
    "storage_mean": ("ercot_energy_storage_resources", "mean", {}),
    "hub_rt_mean": ("ercot_lmp_by_settlement_point", "mean", {"filter_column": "location", "filter_value": HUB}),
    "hub_rt_max": ("ercot_lmp_by_settlement_point", "max", {"filter_column": "location", "filter_value": HUB}),
    "hub_rt_min": ("ercot_lmp_by_settlement_point", "min", {"filter_column": "location", "filter_value": HUB}),
    "hub_da": ("ercot_spp_day_ahead_hourly", None, {"filter_column": "location", "filter_value": HUB}),
    "nspin_mean": ("ercot_mcpc_sced", "mean", {"filter_column": "as_type", "filter_value": "NSPIN"}),
    "nspin_max": ("ercot_mcpc_sced", "max", {"filter_column": "as_type", "filter_value": "NSPIN"}),
    "prc_mean": ("ercot_prc", "mean", {}),
    "prc_min": ("ercot_prc", "min", {}),
}


def main() -> None:
    gs = CachedGridStatus()
    start, end = RANGE.utc_window()
    for label, (dataset, fn, extra) in PULLS.items():
        resample = {"resample": "1 hour", "resample_function": fn} if fn else {}
        df = gs.get(RANGE.id, label, dataset, start=start, end=end, **resample, **extra)
        log.info("%s: %d rows", label, len(df))
    log.info("range fetch done: %d uncached API requests", gs.requests)


if __name__ == "__main__":
    main()
