"""Shared config: scenario windows, paths, and the cached Grid Status client."""

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
STATE = DATA / "state"
ALERTS = DATA / "alerts"
DECISIONS = DATA / "decisions"
WEB_DEMO = ROOT / "web" / "public" / "demo"
CENTRAL = "US/Central"

log = logging.getLogger("pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")


@dataclass(frozen=True)
class Scenario:
    id: str
    title: str
    day: str  # the scenario day, Central
    context_start: str  # first Central day pulled (trend context)
    blog_url: str

    def utc_window(self, start_day: str | None = None) -> tuple[pd.Timestamp, pd.Timestamp]:
        """[00:00 Central of start_day, 00:00 Central of the day after `day`) in UTC."""
        start = pd.Timestamp(start_day or self.day, tz=CENTRAL)
        end = pd.Timestamp(self.day, tz=CENTRAL) + pd.Timedelta(days=1)
        return start.tz_convert("UTC"), end.tz_convert("UTC")


SCENARIOS = {
    "record_load": Scenario(
        id="record_load",
        title="Record load, no scarcity",
        day="2026-07-22",
        context_start="2026-07-21",
        blog_url="https://blog.gridstatus.io/ercot-record-july-2026",
    ),
}


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, sort_keys=False, default=str, allow_nan=False) + "\n")


class CachedGridStatus:
    """gridstatusio client that caches every pull to data/raw/<scenario>/ as parquet.

    The cache key is the full query, so a changed query is a new pull and a re-run spends no quota.
    The Free/Basic tier allows 1 request/s; we sleep between uncached pulls.
    """

    def __init__(self) -> None:
        self._client = None
        self.requests = 0

    def _get_client(self):
        if self._client is None:
            from dotenv import dotenv_values
            from gridstatusio import GridStatusClient

            key = dotenv_values(ROOT / ".env").get("GRIDSTATUS_API_KEY")
            if not key or key.startswith("<"):
                raise SystemExit("GRIDSTATUS_API_KEY missing from .env (needed only for uncached pulls)")
            self._client = GridStatusClient(key)
        return self._client

    def get(self, scenario: str, label: str, dataset: str, **query) -> pd.DataFrame:
        q = {"dataset": dataset, **{k: (v.isoformat() if isinstance(v, pd.Timestamp) else v) for k, v in query.items()}}
        digest = hashlib.sha1(json.dumps(q, sort_keys=True, default=str).encode()).hexdigest()[:10]
        path = RAW / scenario / f"{label}__{digest}.parquet"
        meta = path.with_suffix(".query.json")
        if path.exists():
            return pd.read_parquet(path)
        log.info("pull %s/%s %s", scenario, label, dataset)
        time.sleep(1.2)
        df = self._get_client().get_dataset(dataset, verbose=False, **{k: v for k, v in q.items() if k != "dataset"})
        self.requests += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(path, index=False)
        write_json(meta, {**q, "rows": len(df), "pulled_at_utc": pd.Timestamp.now(tz="UTC").isoformat()})
        return df
