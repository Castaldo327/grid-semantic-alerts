"""Pull every Grid Status dataset the demo needs, cached under data/raw/<scenario>/.

Dataset IDs and columns come from the API catalog (data/raw/catalog_ercot.json, via
`list_datasets`). Why each one:

  ercot_load                      5-min actual system load (ERCOT's real-time system demand)
  ercot_load_forecast_by_forecast_zone
                                  ERCOT's hourly 7-day load forecast keyed by publish_time, so we
                                  can take the latest vintage published before each interval.
                                  (Not ercot_load_forecast: it keeps one row per interval, and on
                                  07-22 most rows carry a vintage published after the day ended.)
  ercot_fuel_mix                  5-min generation by fuel: solar, wind, power_storage
  ercot_energy_storage_resources  5-min total ESR charging / discharging (battery discharge)
  ercot_net_load                  hourly load - solar - wind as published, to check our 5-min calc
  ercot_lmp_by_settlement_point   per-SCED-run real-time LMP by settlement point (hub, zone, node)
  ercot_spp_real_time_15_min      15-min settlement point prices (what the settlement uses)
  ercot_spp_day_ahead_hourly      day-ahead hub price, to compare real-time against
  ercot_sced_system_lambda        per-SCED-run system lambda: the system-wide energy price
  ercot_mcpc_sced                 per-SCED-run ancillary prices (exists from 2025-12-05, RTC+B)
  ercot_as_prices                 hourly day-ahead ancillary prices (both scenarios)
  ercot_shadow_prices_sced        binding transmission constraints per SCED run
  ercot_real_time_adders_and_reserves
                                  per-SCED-run physical responsive capability (PRC), the reserve
                                  measure ERCOT's EEA triggers use, plus the ORDC price adder.
                                  Empty after RTC+B (2025-12-05), so scenario 1 uses ercot_prc
  ercot_prc                       PRC published every ~10 s; 02_state averages it to 5 minutes
"""

import pandas as pd

from pipeline.common import SCENARIOS, CachedGridStatus, log

HUB = "HB_HUBAVG"
S2_LOCATIONS = ["RHESS2_ESS1", "LZ_LCRA", "HB_HUBAVG", "HB_SOUTH"]


def fetch_record_load(gs: CachedGridStatus) -> None:
    s = SCENARIOS["record_load"]
    start, end = s.utc_window(s.context_start)
    day_start, _ = s.utc_window()
    w = dict(start=start, end=end)
    gs.get(s.id, "load", "ercot_load", **w)
    gs.get(s.id, "fuel_mix", "ercot_fuel_mix", **w)
    gs.get(s.id, "storage", "ercot_energy_storage_resources", **w)
    gs.get(s.id, "net_load_hourly", "ercot_net_load", **w)
    gs.get(s.id, "system_lambda", "ercot_sced_system_lambda", **w)
    gs.get(s.id, "mcpc_sced", "ercot_mcpc_sced", **w)
    gs.get(s.id, "as_prices_dam", "ercot_as_prices", **w)
    gs.get(s.id, "prc", "ercot_prc", **w, page_size=50000)
    gs.get(s.id, "hub_lmp_sced", "ercot_lmp_by_settlement_point", **w, filter_column="location", filter_value=HUB)
    gs.get(s.id, "hub_spp_rt15", "ercot_spp_real_time_15_min", **w, filter_column="location", filter_value=HUB)
    gs.get(s.id, "hub_spp_da", "ercot_spp_day_ahead_hourly", **w, filter_column="location", filter_value=HUB)
    # Every forecast vintage published from two days before the scenario day through its end,
    # for intervals on the scenario day. 02_state picks the latest vintage before each interval.
    gs.get(
        s.id, "load_forecast", "ercot_load_forecast_by_forecast_zone",
        start=day_start, end=end, columns=["interval_start_utc", "interval_end_utc", "publish_time_utc", "system_total"],
        publish_time_start=day_start - pd.Timedelta(days=2), publish_time_end=end,
    )


def fetch_local_spike(gs: CachedGridStatus) -> None:
    s = SCENARIOS["local_spike"]
    start, end = s.utc_window()
    w = dict(start=start, end=end)
    loc = dict(filter_column="location", filter_value=S2_LOCATIONS, filter_operator="in")
    gs.get(s.id, "lmp_sced", "ercot_lmp_by_settlement_point", **w, **loc)
    gs.get(s.id, "spp_rt15", "ercot_spp_real_time_15_min", **w, **loc)
    gs.get(s.id, "hub_spp_da", "ercot_spp_day_ahead_hourly", **w, filter_column="location", filter_value=HUB)
    gs.get(s.id, "shadow_prices", "ercot_shadow_prices_sced", **w)
    gs.get(s.id, "system_lambda", "ercot_sced_system_lambda", **w)
    gs.get(s.id, "load", "ercot_load", **w)
    gs.get(s.id, "fuel_mix", "ercot_fuel_mix", **w)
    gs.get(s.id, "storage", "ercot_energy_storage_resources", **w)
    gs.get(s.id, "as_prices_dam", "ercot_as_prices", **w)
    gs.get(s.id, "reserves", "ercot_real_time_adders_and_reserves", **w)


def main() -> None:
    gs = CachedGridStatus()
    fetch_record_load(gs)
    fetch_local_spike(gs)
    log.info("fetch done: %d uncached API requests", gs.requests)


if __name__ == "__main__":
    main()
