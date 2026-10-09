"""Build the per-interval grid state for each scenario: numeric series plus short prose.

One row per 5-minute interval of the scenario day (Central). Rules:
  - Prose at interval t uses only data at or before t (no lookahead: "highest so far today").
  - Per-SCED-run series (prices, ancillary prices, constraints) take the last SCED run whose
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

# The blog post for scenario 2 names the GEORSO substation (Georgetown) among the constraints
# around the Rabbit Hill node. We don't have shift factors, so this is the only node-specific
# link we use; it comes from the blog, not from the data.
NEAR_NODE_STATIONS = {"GEORSO"}


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


def none_if_nan(v):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else v


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


# ---------- scenario 2 ----------

def build_local_spike() -> dict:
    s = SCENARIOS["local_spike"]
    start, end = s.utc_window()
    idx = grid(start, end)
    sid = s.id

    lmp = raw(sid, "lmp_sced").pivot_table(index="sced_timestamp_utc", columns="location", values="lmp").reset_index()
    px = last_in_bucket(lmp, "sced_timestamp_utc", ["RHESS2_ESS1", "LZ_LCRA", "HB_HUBAVG", "HB_SOUTH"], idx)
    res = last_in_bucket(raw(sid, "reserves"), "sced_timestamp_utc", ["prc", "rtorpa"], idx)
    lam = last_in_bucket(raw(sid, "system_lambda"), "sced_timestamp_utc", ["system_lambda"], idx)["system_lambda"]
    load = on_grid(raw(sid, "load"), "interval_start_utc", ["load"], idx)["load"]
    fm = on_grid(raw(sid, "fuel_mix"), "interval_start_utc", ["solar", "wind"], idx)
    da = hourly_ffill(raw(sid, "hub_spp_da"), "interval_start_utc", "spp", idx)

    # A constraint is binding when its shadow price is positive; the dataset also lists $0 rows.
    sp = raw(sid, "shadow_prices").assign(t=lambda d: utc(d.sced_timestamp_utc))
    sp["bucket"] = sp.t.dt.floor(FIVE)
    last_run = sp.groupby("bucket").t.transform("max")
    sp = sp[(sp.t == last_run) & (sp.shadow_price > 0)].copy()
    sp["overload"] = (sp.value - sp.limit) / sp.limit
    sp["near_node"] = sp.from_station.isin(NEAR_NODE_STATIONS) | sp.to_station.isin(NEAR_NODE_STATIONS)

    df = pd.DataFrame(index=idx)
    df["node_price"] = px.RHESS2_ESS1
    df["lcra_price"] = px.LZ_LCRA
    df["hub_rt_price"] = px.HB_HUBAVG
    df["south_hub_price"] = px.HB_SOUTH
    df["spread"] = px.RHESS2_ESS1 - px.HB_HUBAVG
    df["hub_da_price"] = da
    df["system_lambda"] = lam
    df["prc_mw"] = res.prc
    df["ordc_adder"] = res.rtorpa
    df["load_mw"] = load
    df["net_load_mw"] = load - fm.solar - fm.wind
    df["n_binding"] = sp.groupby("bucket").size().reindex(idx)
    df["max_shadow_price"] = sp.groupby("bucket").shadow_price.max().reindex(idx)
    df["near_node_shadow_price"] = sp[sp.near_node].groupby("bucket").shadow_price.max().reindex(idx)

    intervals = []
    for t in idx:
        r = df.loc[t]
        p = [f"It is {clock(t)} in Texas on February 19, 2025."]
        if ok(r.node_price):
            n = f"The price at the Rabbit Hill battery node (RHESS2_ESS1) is {usd(r.node_price)}"
            na = ago(df.node_price, t)
            if ok(na) and abs(r.node_price - na) >= max(50, 0.2 * abs(na)):
                n += f", {'up' if r.node_price > na else 'down'} from {usd(na)} an hour ago"
            p.append(n + ".")
        if ok(r.hub_rt_price):
            p.append(f"The ERCOT hub average price is {usd(r.hub_rt_price)}.")
        if ok(r.spread):
            p.append(f"The node is {usd(abs(r.spread)).replace('/MWh', '')} {'above' if r.spread >= 0 else 'below'} the hub.")
        if ok(r.lcra_price):
            p.append(f"The LCRA load zone (central Texas) price is {usd(r.lcra_price)}.")
        if ok(r.south_hub_price):
            p.append(f"The South hub price is {usd(r.south_hub_price)}.")
        cons = sp[sp.bucket == t].sort_values(["shadow_price", "overload"], ascending=False)
        if len(cons):
            top = cons.head(3)
            desc = "; ".join(
                f"{c.constraint_name} for contingency {c.contingency_name} ({c.from_station}-{c.to_station}), "
                f"shadow price {usd(c.shadow_price)}, flow {c.value:.0f} MW vs limit {c.limit:.0f} MW"
                for c in top.itertuples()
            )
            p.append(f"{len(cons)} transmission constraints are binding. Highest shadow prices: {desc}.")
            near = cons[cons.near_node].head(1) if not top.near_node.any() else cons.iloc[0:0]
            for c in near.itertuples():
                p.append(f"Also binding near the node: {c.constraint_name} on {c.from_station}-{c.to_station}, "
                         f"shadow price {usd(c.shadow_price)}.")
        if ok(r.prc_mw):
            p.append(f"Physical responsive capability (operating reserves) is {gw(r.prc_mw)}.")
        if ok(r.load_mw):
            p.append(f"ERCOT demand is {gw(r.load_mw)}.")
        intervals.append({"t": t.isoformat(), "prose": " ".join(p)})

    top_by_interval = {
        t.isoformat(): [
            {"constraint": c.constraint_name, "contingency": c.contingency_name, "from": none_if_nan(c.from_station),
             "to": none_if_nan(c.to_station), "shadow_price": round(float(c.shadow_price), 2), "limit": float(c.limit),
             "flow": float(c.value), "near_node": bool(c.near_node)}
            for c in g.sort_values(["shadow_price", "overload"], ascending=False).head(5).itertuples()
        ]
        for t, g in sp.groupby("bucket")
    }
    for it in intervals:
        it["constraints"] = top_by_interval.get(it["t"], [])

    series_cols = ["node_price", "lcra_price", "hub_rt_price", "south_hub_price", "spread", "hub_da_price",
                   "system_lambda", "prc_mw", "ordc_adder", "load_mw", "net_load_mw", "n_binding",
                   "max_shadow_price", "near_node_shadow_price"]
    return finish(s, df, intervals, series_cols, coarse=["hub_da_price"], datasets={
        "node_price": "ercot_lmp_by_settlement_point (RHESS2_ESS1)", "lcra_price": "ercot_lmp_by_settlement_point (LZ_LCRA)",
        "hub_rt_price": "ercot_lmp_by_settlement_point (HB_HUBAVG)", "south_hub_price": "ercot_lmp_by_settlement_point (HB_SOUTH)",
        "spread": "computed: node - hub", "hub_da_price": "ercot_spp_day_ahead_hourly (HB_HUBAVG)",
        "system_lambda": "ercot_sced_system_lambda", "prc_mw": "ercot_real_time_adders_and_reserves (prc)",
        "ordc_adder": "ercot_real_time_adders_and_reserves (rtorpa)", "load_mw": "ercot_load",
        "net_load_mw": "computed: load - solar - wind (ercot_fuel_mix)", "n_binding": "ercot_shadow_prices_sced",
        "max_shadow_price": "ercot_shadow_prices_sced", "near_node_shadow_price": "ercot_shadow_prices_sced (GEORSO)",
    }, extra={"near_node_stations": sorted(NEAR_NODE_STATIONS)})


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
    for build in (build_record_load, build_local_spike):
        out = build()
        write_json(STATE / f"{out['scenario']}.json", out)
        lens = [len(i["prose"]) for i in out["intervals"]]
        log.info("%s: %d intervals, prose %d-%d chars", out["scenario"], len(lens), min(lens), max(lens))


if __name__ == "__main__":
    main()
