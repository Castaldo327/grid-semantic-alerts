"""Build the per-interval grid state for each scenario: numeric series plus short prose.

One row per 5-minute interval of the scenario day (Central). Rules:
  - Prose at interval t uses only data at or before t (no lookahead: "highest so far today").
  - Per-SCED-run series (prices, ancillary prices) take the last SCED run whose
    timestamp falls in the interval.
  - Hourly series (load forecast, day-ahead price) are forward-filled to 5 minutes and listed in
    `coarse_series`.
  - Missing values stay missing (null in JSON, left out of the prose). Nothing is interpolated.
"""

import glob

import numpy as np
import pandas as pd

from pipeline.common import CENTRAL, RAW, SCENARIOS, STATE, log, write_json

FIVE = pd.Timedelta(minutes=5)

def raw(scenario: str, label: str) -> pd.DataFrame:
    paths = glob.glob(str(RAW / scenario / f"{label}__*.parquet"))
    if len(paths) != 1:
        raise SystemExit(f"expected one cached pull for {scenario}/{label}, found {paths}; run 01_fetch")
    return pd.read_parquet(paths[0])


def utc(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, utc=True)


def grid(start: pd.Timestamp, end: pd.Timestamp) -> pd.DatetimeIndex:
    return pd.date_range(start, end, freq=FIVE, inclusive="left", name="t")


def on_grid(df: pd.DataFrame, tcol: str, cols: list[str], idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Values whose timestamp is an interval start, reindexed to the grid (no fill)."""
    d = df.assign(t=utc(df[tcol])).drop_duplicates("t", keep="last").set_index("t")[cols]
    return d.reindex(idx)


def last_in_bucket(df: pd.DataFrame, tcol: str, cols: list[str], idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Last SCED run in each 5-minute bucket."""
    d = df.assign(t=utc(df[tcol])).sort_values("t")
    d["bucket"] = d["t"].dt.floor(FIVE)
    return d.groupby("bucket")[cols].last().reindex(idx)


def hourly_ffill(df: pd.DataFrame, tcol: str, col: str, idx: pd.DatetimeIndex) -> pd.Series:
    d = df.assign(t=utc(df[tcol])).drop_duplicates("t", keep="last").set_index("t")[col].sort_index()
    return d.reindex(d.index.union(idx)).ffill(limit=12).reindex(idx)


def forecast_as_of(lf: pd.DataFrame, idx: pd.DatetimeIndex) -> pd.Series:
    """For each 5-min interval: the hourly forecast for its hour from the latest vintage
    published strictly before the interval starts."""
    lf = lf.assign(hour=utc(lf.interval_start_utc), pub=utc(lf.publish_time_utc)).sort_values("pub")
    out = []
    for t in idx:
        cand = lf[(lf.hour == t.floor("h")) & (lf.pub < t)]
        out.append(cand.system_total.iloc[-1] if len(cand) else np.nan)
    return pd.Series(out, index=idx)


# ---------- prose helpers ----------

def clock(t: pd.Timestamp) -> str:
    return t.tz_convert(CENTRAL).strftime("%-I:%M %p")


def gw(mw: float) -> str:
    return f"{mw / 1000:.1f} GW"


def usd(x: float) -> str:
    return f"${x:,.0f}/MWh"


def ok(*xs) -> bool:
    return all(x is not None and not (isinstance(x, float) and np.isnan(x)) for x in xs)


def trend_mw(now: float, before: float, flat_mw: float) -> str:
    """'up 0.6 GW in the last hour' / 'flat over the last hour'."""
    if not ok(now, before):
        return ""
    d = now - before
    if abs(d) < flat_mw:
        return "flat over the last hour"
    return f"{'up' if d > 0 else 'down'} {abs(d) / 1000:.1f} GW in the last hour"


def ago(s: pd.Series, t: pd.Timestamp, minutes: int = 60):
    v = s.get(t - pd.Timedelta(minutes=minutes))
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v)


# ---------- scenario 1 ----------

def build_record_load(battery_cut_mw: float = 0) -> dict:
    """battery_cut_mw > 0 builds the Phase 7 what-if: that much battery discharge removed at every
    interval (floored at zero) and added to net load. Every other series stays real."""
    s = SCENARIOS["record_load"]
    cstart, end = s.utc_window(s.context_start)
    dstart, _ = s.utc_window()
    idx_all = grid(cstart, end)
    sid = s.id

    load = on_grid(raw(sid, "load"), "interval_start_utc", ["load"], idx_all)["load"]
    fm = on_grid(raw(sid, "fuel_mix"), "interval_start_utc", ["solar", "wind", "power_storage"], idx_all)
    st = on_grid(raw(sid, "storage"), "time_utc", ["total_discharging", "total_charging", "net_output"], idx_all)
    hub = last_in_bucket(raw(sid, "hub_lmp_sced"), "sced_timestamp_utc", ["lmp"], idx_all)["lmp"]
    lam = last_in_bucket(raw(sid, "system_lambda"), "sced_timestamp_utc", ["system_lambda"], idx_all)["system_lambda"]
    mc = raw(sid, "mcpc_sced").pivot_table(index="sced_timestamp_utc", columns="as_type", values="mcpc").reset_index()
    mcpc = last_in_bucket(mc, "sced_timestamp_utc", ["NSPIN", "ECRS", "RRS", "REGUP"], idx_all)
    prc_raw = raw(sid, "prc").assign(t=lambda d: utc(d.time_utc))
    prc = prc_raw.set_index("t").prc.resample(FIVE).mean().reindex(idx_all)
    da = hourly_ffill(raw(sid, "hub_spp_da"), "interval_start_utc", "spp", idx_all)

    df = pd.DataFrame(index=idx_all)
    df["load_mw"] = load
    df["solar_mw"] = fm.solar
    df["wind_mw"] = fm.wind
    df["net_load_mw"] = load - fm.solar - fm.wind
    df["battery_discharge_mw"] = st.total_discharging
    df["battery_net_mw"] = st.net_output
    df["hub_rt_price"] = hub
    df["hub_da_price"] = da
    df["system_lambda"] = lam
    df["nspin_price"] = mcpc.NSPIN
    df["ecrs_price"] = mcpc.ECRS
    df["rrs_price"] = mcpc.RRS
    df["prc_mw"] = prc
    if battery_cut_mw:
        removed = df.battery_discharge_mw.clip(lower=0, upper=battery_cut_mw)
        df["battery_discharge_mw"] -= removed
        df["battery_net_mw"] -= removed
        df["net_load_mw"] += removed
    df["load_forecast_mw"] = np.nan
    day = df.loc[dstart:].copy()
    day["load_forecast_mw"] = forecast_as_of(raw(sid, "load_forecast"), day.index)
    df.loc[day.index, "load_forecast_mw"] = day["load_forecast_mw"]

    prev_day = df.loc[cstart:dstart - FIVE]
    prev_peak = float(prev_day.load_mw.max())
    intervals = []
    for t in day.index:
        r = df.loc[t]
        so_far = df.loc[dstart:t]
        p: list[str] = [f"It is {clock(t)} in Texas on July 22, 2026."]
        if ok(r.load_mw):
            parts = [f"ERCOT demand is {gw(r.load_mw)}"]
            if ok(r.load_forecast_mw):
                d = r.load_mw - r.load_forecast_mw
                if abs(d) < 100:
                    parts.append("in line with forecast")
                else:
                    parts.append(f"{abs(d) / 1000:.1f} GW {'above' if d >= 0 else 'below'} forecast")
            tr = trend_mw(r.load_mw, ago(df.load_mw, t), 300)
            if tr:
                parts.append(tr)
            p.append(", ".join(parts) + ".")
            if r.load_mw > prev_peak:
                p.append(f"That is above yesterday's peak of {gw(prev_peak)}.")
        if ok(r.solar_mw):
            pk_t = so_far.solar_mw.idxmax()
            pk = so_far.solar_mw.max()
            if pk - r.solar_mw > 2000:
                p.append(f"Solar is {gw(r.solar_mw)}, down from {gw(pk)} at {clock(pk_t)}.")
            else:
                p.append(f"Solar is {gw(r.solar_mw)}.")
        if ok(r.wind_mw):
            p.append(f"Wind is {gw(r.wind_mw)}.")
        if ok(r.battery_discharge_mw):
            b_ago = ago(df.battery_discharge_mw, t)
            b = f"Batteries are discharging {gw(r.battery_discharge_mw)}"
            if ok(b_ago) and abs(r.battery_discharge_mw - b_ago) >= 500:
                b += f", {'up' if r.battery_discharge_mw > b_ago else 'down'} from {gw(b_ago)} an hour ago"
            pk = so_far.battery_discharge_mw.max()
            if pk - r.battery_discharge_mw > 2000:
                b += f" (today's peak so far {gw(pk)})"
            p.append(b + ".")
        if ok(r.net_load_mw):
            nl = (f"Net load (demand minus wind and solar, plus the {gw(battery_cut_mw)} of battery output removed "
                  f"in this simulation) is {gw(r.net_load_mw)}" if battery_cut_mw else
                  f"Net load (demand minus wind and solar) is {gw(r.net_load_mw)}")
            if r.net_load_mw >= so_far.net_load_mw.max():
                nl += ", the highest so far today"
            p.append(nl + ".")
        if ok(r.hub_rt_price):
            h = f"Hub average real-time price is {usd(r.hub_rt_price)}"
            if ok(r.hub_da_price):
                rel = "above" if r.hub_rt_price > r.hub_da_price else "below"
                h += f", {rel} the day-ahead price of {usd(r.hub_da_price)}"
            p.append(h + ".")
        if ok(r.nspin_price):
            p.append(f"Non-spinning reserve price is {usd(r.nspin_price)}.")
        if ok(r.prc_mw):
            pr = f"Physical responsive capability (operating reserves) is {gw(r.prc_mw)}"
            pa = ago(df.prc_mw, t)
            if ok(pa) and abs(r.prc_mw - pa) >= 500:
                pr += f", {'up' if r.prc_mw > pa else 'down'} from {gw(pa)} an hour ago"
            p.append(pr + ".")
        intervals.append({"t": t.isoformat(), "prose": " ".join(p)})

    series_cols = ["load_mw", "load_forecast_mw", "solar_mw", "wind_mw", "net_load_mw", "battery_discharge_mw",
                   "battery_net_mw", "hub_rt_price", "hub_da_price", "system_lambda", "nspin_price", "ecrs_price",
                   "rrs_price", "prc_mw"]
    return finish(s, day, intervals, series_cols, coarse=["load_forecast_mw", "hub_da_price"], datasets={
        "load_mw": "ercot_load", "load_forecast_mw": "ercot_load_forecast_by_forecast_zone (system_total)",
        "solar_mw": "ercot_fuel_mix", "wind_mw": "ercot_fuel_mix", "net_load_mw": "computed: load - solar - wind",
        "battery_discharge_mw": "ercot_energy_storage_resources (total_discharging)",
        "battery_net_mw": "ercot_energy_storage_resources (net_output)",
        "hub_rt_price": "ercot_lmp_by_settlement_point (HB_HUBAVG)", "hub_da_price": "ercot_spp_day_ahead_hourly (HB_HUBAVG)",
        "system_lambda": "ercot_sced_system_lambda", "nspin_price": "ercot_mcpc_sced (NSPIN)",
        "ecrs_price": "ercot_mcpc_sced (ECRS)", "rrs_price": "ercot_mcpc_sced (RRS)", "prc_mw": "ercot_prc (5-min mean)",
    }, extra={"previous_day_peak_load_mw": prev_peak, **({"simulated": {
        "label": "Simulated scenario: real data with batteries removed",
        "battery_cut_mw": battery_cut_mw,
        "method": f"Battery discharge reduced by up to {battery_cut_mw:,.0f} MW at every interval (floored at zero); "
                  "the removed amount is added to net load. Prices, reserves (PRC) and every other series are the "
                  "real values, so this tests how the model reads battery and net-load numbers, not what the grid "
                  "would actually have done.",
    }} if battery_cut_mw else {})})


def finish(s, day: pd.DataFrame, intervals: list[dict], cols: list[str], coarse: list[str], datasets: dict, extra: dict) -> dict:
    def clean(v):
        return None if pd.isna(v) else round(float(v), 2)

    missing = {c: int(day[c].isna().sum()) for c in cols if day[c].isna().any()}
    if missing:
        log.info("%s missing values (left null): %s", s.id, missing)
    return {
        "scenario": s.id,
        "title": s.title,
        "day": s.day,
        "timezone": CENTRAL,
        "blog_url": s.blog_url,
        "t": [t.isoformat() for t in day.index],
        "series": {c: [clean(v) for v in day[c]] for c in cols},
        "coarse_series": coarse,
        "series_source": datasets,
        "missing": missing,
        "intervals": intervals,
        **extra,
    }


def main() -> None:
    for build in (build_record_load,):
        out = build()
        write_json(STATE / f"{out['scenario']}.json", out)
        lens = [len(i["prose"]) for i in out["intervals"]]
        log.info("%s: %d intervals, prose %d-%d chars", out["scenario"], len(lens), min(lens), max(lens))


if __name__ == "__main__":
    main()
