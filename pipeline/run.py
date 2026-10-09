"""Run the whole pipeline in order. July 22: fetch (cached) -> state -> compile -> decide -> compose ->
what-if. Week explorer: hourly range fetch (cached) -> hourly dataset and unusual days.

Grid Status pulls are cached in data/raw/, and every gpt-6-luna request in data/cache/luna/, so a
re-run replays identical outputs and spends no API quota. The explorer's saved example runs come
from web/scripts/save_runs.ts (`make all` runs it after this).
"""

import importlib

STEPS = ["01_fetch", "02_state", "03_compile", "04_decide", "05_compose", "06_whatif", "07_range_fetch", "08_range_state"]


def main() -> None:
    for step in STEPS:
        print(f"== {step}")
        importlib.import_module(f"pipeline.{step}").main()


if __name__ == "__main__":
    main()
