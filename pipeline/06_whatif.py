"""Phase 7 what-if: "What if 8 GW of batteries had been offline on July 22?"

Rebuilds scenario 1's state with battery discharge cut by 8 GW (02_state.build_record_load), reruns
the decision model with alert A's compiled questions, and composes firings. Output goes to a
separate file, web/public/demo/whatif_<alert_id>.json, never mixed into the real run.
"""

import importlib
import json

from pipeline.common import ALERTS, STATE, WEB_DEMO, log, write_json

CUT_MW = 8000


def main() -> None:
    state_mod = importlib.import_module("pipeline.02_state")
    decide_mod = importlib.import_module("pipeline.04_decide")
    compose_mod = importlib.import_module("pipeline.05_compose")

    state = state_mod.build_record_load(battery_cut_mw=CUT_MW)
    write_json(STATE / "record_load__batteries_minus_8gw.json", state)
    entry = json.loads((ALERTS / "index.json").read_text())["A"]
    alert = json.loads((ALERTS / f"{entry['alert_id']}.json").read_text())
    dec = decide_mod.run_alert(alert, state)
    out = compose_mod.compose(alert, state, dec, explain_on=False)
    out["simulated"] = state["simulated"]
    path = WEB_DEMO / f"whatif_{alert['alert_id']}.json"
    path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False) + "\n")
    log.info("what-if: semantic fired %d (rule true at %d intervals); written to %s",
             len(out["fired"]["semantic"]), sum(out["rule_true"]), path.name)


if __name__ == "__main__":
    main()
