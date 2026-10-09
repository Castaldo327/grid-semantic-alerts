"""Run the whole pipeline in order: fetch (cached) -> state -> compile -> decide -> compose -> what-if.

Grid Status pulls are cached in data/raw/, and every gpt-6-luna request in data/cache/luna/, so a
re-run replays identical outputs and spends no API quota.
"""

import importlib

STEPS = ["01_fetch", "02_state", "03_compile", "04_decide", "05_compose", "06_whatif"]


def main() -> None:
    for step in STEPS:
        print(f"== {step}")
        importlib.import_module(f"pipeline.{step}").main()


if __name__ == "__main__":
    main()
