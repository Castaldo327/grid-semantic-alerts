"""Build the week explorer's dataset (web/public/explore/ercot_hourly.json) from 07_range_fetch's pulls.

One row per hour from 30 days before RANGE.first_day to the end of RANGE.last_day (Central). The
page writes each hour's snapshot text from these numbers in the browser (web/src/explore/snapshot.ts),
so the file holds numbers only:

  load, load_max          demand: hourly mean and 5-minute peak (MW)
  solar, wind             hourly mean (MW)
  net                     load - solar - wind (MW)
  bat_dis, bat_chg        battery discharging and charging, hourly mean (MW; Grid Status reports
                          charging as negative, stored here as a positive amount)
  hub, hub_max, hub_min   hub (HB_HUBAVG) real-time price: mean, high, low ($/MWh)
  da                      hub day-ahead price ($/MWh)
  nspin, nspin_max        non-spinning reserve real-time price: mean, high ($/MWh)
  prc, prc_min            physical responsive capability (operating reserves): mean, low (MW)
  temp                    observed temperature across ERCOT's 8 weather zones, weighted by each
                          zone's share of load over the range (F); temp_dfw (North Central) and
                          temp_hou (Coast) are the two biggest load zones

It also flags unusual days, so the page can point people at weeks where something happened: most
days are ordinary, and an alert run on an ordinary week has nothing to find. A day is flagged for
each of these it meets (thresholds were set from the range's own distribution, each flagging
roughly the most extreme 3-8% of days):

  reserves     operating reserves fell below 5.5 GW
  price        hub real-time price reached $300/MWh
  reserve_price  non-spinning reserve price reached $100/MWh
  negative     hub real-time price fell below -$10/MWh
  demand       demand reached 90 GW (the July 22 threshold alert's line)
  wind         wind averaged under 6 GW for the day
  heat         the demand-weighted temperature reached 100F
  freeze       the demand-weighted temperature fell to 32F or below

Suggested weeks are hand-picked, one per kind of event, the heat wave first (the "Create alert" page
opens on it). Each is a full example for that page: an alert name, a sentence alert, and the threshold alert someone would set today for the same
worry (series ids are web/src/explore/series.ts's).
"""

import glob
import json
import math

import pandas as pd

from pipeline.common import CENTRAL, EXPLORE, RANGE, RAW, log

PULLS = {  # series name: (pull label, column)
    "load": ("load_mean", "load"), "load_max": ("load_max", "load"),
    "solar": ("fuel_mix_mean", "solar"), "wind": ("fuel_mix_mean", "wind"),
    "bat_dis": ("storage_mean", "total_discharging"), "bat_chg": ("storage_mean", "total_charging"),
    "hub": ("hub_rt_mean", "lmp"), "hub_max": ("hub_rt_max", "lmp"), "hub_min": ("hub_rt_min", "lmp"),
    "da": ("hub_da", "spp"), "nspin": ("nspin_mean", "mcpc"), "nspin_max": ("nspin_max", "mcpc"),
    "prc": ("prc_mean", "prc"), "prc_min": ("prc_min", "prc"),
}
ZONES = ["coast", "east", "far_west", "north", "north_central", "south_central", "southern", "west"]
PRICES = {"hub", "hub_max", "hub_min", "da", "nspin", "nspin_max"}
TEMPS = {"temp", "temp_dfw", "temp_hou"}
DATASETS = ["ercot_load", "ercot_fuel_mix", "ercot_energy_storage_resources", "ercot_lmp_by_settlement_point (HB_HUBAVG)",
            "ercot_spp_day_ahead_hourly (HB_HUBAVG)", "ercot_mcpc_sced (NSPIN)", "ercot_prc",
            "ercot_temperature_forecast_by_weather_zone", "ercot_load_by_weather_zone"]

THRESHOLDS = {
    "reserves": {"label": "Reserves below 5.5 GW", "mw": 5500},
    "price": {"label": "Hub price at or above $300/MWh", "usd": 300},
    "reserve_price": {"label": "Non-spin price at or above $100/MWh", "usd": 100},
    "negative": {"label": "Hub price below -$10/MWh", "usd": -10},
    "demand": {"label": "Demand at or above 90 GW", "mw": 90000},
    "wind": {"label": "Wind under 6 GW for the day", "mw": 6000},
    "heat": {"label": "Temperature at or above 100°F (demand-weighted)", "f": 100},
    "freeze": {"label": "Temperature at or below 32°F (demand-weighted)", "f": 32},
}

WEEKS = [
    {"start": "2026-08-20", "title": "Heat wave", "name": "Short of reserves in the heat",
     "threshold": {"series": "load", "op": ">", "value": 90000},
     "note": "Over 100°F on four days and demand near 90 GW every day, but reserves only ran short on the 22nd, 23rd and 26th, when they fell to about 5.5 GW and reserve prices spiked.",
     "example": "Warn me when the grid is running short of reserves, not just when it's hot."},
    {"start": "2026-01-22", "title": "Winter freeze", "name": "Freeze shortage",
     "threshold": {"series": "hub", "op": ">", "value": 300},
     "note": "A hard freeze from the 24th to the 27th (down to 19°F, demand-weighted) sent prices to $938 on the 25th with 13 GW of reserves to spare. The shortage came on the morning of the 28th: reserves fell to 5.7 GW and prices hit $1,350.",
     "example": "Warn me when the freeze is actually leaving ERCOT short of reserves, not just driving up prices."},
    {"start": "2026-07-19", "title": "Record demand", "name": "Scarcity, not records",
     "threshold": {"series": "load", "op": ">", "value": 90000},
     "note": "ERCOT's all-time demand record on Wednesday, then a tight evening as solar faded.",
     "example": "Tell me when ERCOT is actually heading toward scarcity, not just setting demand records."},
    {"start": "2026-02-18", "title": "Negative prices", "name": "Renewables push prices negative",
     "threshold": {"series": "hub", "op": "<", "value": 0},
     "note": "Strong wind held the hub price below zero for 25 hours, nine of them on the 24th.",
     "example": "Let me know when there's so much wind and solar that prices go negative."},
    {"start": "2026-10-02", "title": "Low wind", "name": "Low wind, short evening",
     "threshold": {"series": "wind", "op": "<", "value": 3000},
     "note": "Wind averaged under 6 GW on five days; prices and reserve prices jumped on the 5th and 7th.",
     "example": "Warn me when weak wind leaves ERCOT short of reserves in the evening."},
]


def raw(label: str) -> pd.DataFrame:
    paths = glob.glob(str(RAW / RANGE.id / f"{label}__*.parquet"))
    if len(paths) != 1:
        raise SystemExit(f"expected one cached pull for {RANGE.id}/{label}, found {paths}; run 07_range_fetch")
    d = pd.read_parquet(paths[0])
    return d.assign(t=pd.to_datetime(d.interval_start_utc, utc=True)).drop_duplicates("t", keep="last").set_index("t")


def gw(mw: float) -> str:
    return f"{mw / 1000:.1f} GW"


def usd(x: float) -> str:
    return f"-${-x:,.0f}/MWh" if x < 0 else f"${x:,.0f}/MWh"


def deg(f: float) -> str:
    """Round half up, like the page's Math.round, so a tag and the snapshot agree."""
    return f"{math.floor(f + 0.5)}°F"


def hour_label(t: pd.Timestamp) -> str:
    return t.tz_convert(CENTRAL).strftime("%-I %p")


def day_tags(h: pd.DataFrame) -> list[dict]:
    """The flags a day meets, each with a short sentence for the page. `h` is that day's hours."""
    tags = []
    if h.prc_min.min() < THRESHOLDS["reserves"]["mw"]:
        t = h.prc_min.idxmin()
        tags.append({"kind": "reserves", "text": f"Reserves fell to {gw(h.prc_min[t])} around {hour_label(t)}"})
    if h.hub_max.max() >= THRESHOLDS["price"]["usd"]:
        t = h.hub_max.idxmax()
        tags.append({"kind": "price", "text": f"Hub price reached {usd(h.hub_max[t])} around {hour_label(t)}"})
    if h.nspin_max.max() >= THRESHOLDS["reserve_price"]["usd"]:
        t = h.nspin_max.idxmax()
        tags.append({"kind": "reserve_price", "text": f"Non-spin price reached {usd(h.nspin_max[t])} around {hour_label(t)}"})
    if h.hub_min.min() < THRESHOLDS["negative"]["usd"]:
        t = h.hub_min.idxmin()
        tags.append({"kind": "negative", "text": f"Hub price fell to {usd(h.hub_min[t])} around {hour_label(t)}"})
    if h.load_max.max() >= THRESHOLDS["demand"]["mw"]:
        t = h.load_max.idxmax()
        tags.append({"kind": "demand", "text": f"Demand peaked at {gw(h.load_max[t])} around {hour_label(t)}"})
    if h.wind.mean() < THRESHOLDS["wind"]["mw"]:
        tags.append({"kind": "wind", "text": f"Wind averaged {gw(h.wind.mean())} for the day"})
    if h.temp.max() >= THRESHOLDS["heat"]["f"]:
        t = h.temp.idxmax()
        tags.append({"kind": "heat", "text": f"Temperature reached {deg(h.temp[t])} around {hour_label(t)}"})
    if h.temp.min() <= THRESHOLDS["freeze"]["f"]:
        t = h.temp.idxmin()
        tags.append({"kind": "freeze", "text": f"Temperature fell to {deg(h.temp[t])} around {hour_label(t)}"})
    return tags


def main() -> None:
    start, end = RANGE.utc_window()
    idx = pd.date_range(start, end, freq="1h", inclusive="left", name="t")
    df = pd.DataFrame({name: raw(label)[col] for name, (label, col) in PULLS.items()}).reindex(idx)
    df["net"] = df.load - df.solar - df.wind
    df["bat_chg"] = -df.bat_chg
    zone_temp = raw("temp")[ZONES].reindex(idx)
    weight = raw("zone_load_monthly")[ZONES].mean()
    weight /= weight.sum()
    # Rounded here as shipped, so the day tags read the same numbers the page's snapshots do.
    df["temp"] = ((zone_temp * weight).sum(axis=1, min_count=1) / (zone_temp.notna() * weight).sum(axis=1)).round(1)
    df["temp_dfw"] = zone_temp.north_central
    df["temp_hou"] = zone_temp.coast

    first = pd.Timestamp(RANGE.first_day, tz=CENTRAL).tz_convert("UTC")
    shown = df.loc[first:]
    missing = {c: int(n) for c, n in shown.isna().sum().items() if n}
    if missing:
        log.info("missing hours in the explorer range (left null): %s", missing)

    days = []
    local_day = shown.index.tz_convert(CENTRAL).date
    for day, h in shown.groupby(local_day):
        tags = day_tags(h)
        days.append({"date": day.isoformat(), "first_hour": int(df.index.get_loc(h.index[0])), "hours": len(h),
                     "tags": tags})

    def clean(name: str, v):
        if pd.isna(v):
            return None
        if name in TEMPS:
            return round(float(v), 1)
        return round(float(v), 2) if name in PRICES else int(round(float(v)))

    order = ["load", "load_max", "solar", "wind", "net", "bat_dis", "bat_chg", "hub", "hub_max", "hub_min", "da",
             "nspin", "nspin_max", "prc", "prc_min", "temp", "temp_dfw", "temp_hou"]
    out = {
        "range": {"first_day": RANGE.first_day, "last_day": RANGE.last_day, "context_days": RANGE.context_days,
                  "timezone": CENTRAL},
        "t0": idx[0].isoformat(),
        "hours": len(idx),
        "series": {c: [clean(c, v) for v in df[c]] for c in order},
        "days": days,
        "thresholds": {k: v["label"] for k, v in THRESHOLDS.items()},
        "temp_weights": {z: round(float(w), 3) for z, w in weight.items()},
        "weeks": WEEKS,
        "datasets": DATASETS,
    }
    for w in WEEKS:
        assert RANGE.first_day <= w["start"] <= RANGE.last_day, w
    path = EXPLORE / "ercot_hourly.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False) + "\n")
    flagged = sum(bool(d["tags"]) for d in days)
    log.info("explorer: %d hours (%d shown), %d days, %d flagged as unusual", len(idx), len(shown), len(days), flagged)


if __name__ == "__main__":
    main()
