#!/usr/bin/env python3
"""Happy-path CascadeIQ flow: interpret → audit → recommend → verify.

    uv run python scripts/demo_flow.py
    uv run python scripts/demo_flow.py --fixture   # skip live inference
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env", override=False)

from cascadeiq.engine.models import Scenario, default_demo_scenario  # noqa: E402
from cascadeiq.engine.simulator import compare_results, run_simulation  # noqa: E402
from cascadeiq.inference.qwen import (  # noqa: E402
    InferenceError,
    interpret_incident,
    load_interpret_fixture,
    load_recommend_fixture,
    recommend_mitigation,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()

    text = (ROOT / "fixtures" / "sample_incident.txt").read_text().strip()
    print("=== 1) INTERPRET ===")
    if args.fixture:
        fix = load_interpret_fixture()
        scenario = Scenario.model_validate(fix["scenario"])
        scenario.source_text = text
        print("inference_used=False (fixture)")
        print("missing_fields=", fix.get("missing_fields"))
    else:
        try:
            out = interpret_incident(text)
            scenario = out["scenario"]
            print("inference_used=True")
            print("validation_status=", out["validation_status"])
            print("missing_fields=", out["missing_fields"])
            print("raw keys=", list((out.get("raw_model_output") or {}).keys()))
        except InferenceError as exc:
            print("INFERENCE_ERROR:", exc)
            print("Falling back to demo scenario (inference_used=False)")
            scenario = default_demo_scenario(source_text=text)

    print("=== 2) AUDIT ===")
    baseline = run_simulation(scenario)
    m = baseline.metrics
    print(
        json.dumps(
            {
                "unique_failed": m.unique_failed_checkouts,
                "unique_success": m.unique_successful_checkouts,
                "retry_amplification": m.retry_amplification,
                "peak_backlog": m.peak_backlog,
                "highest_impact": m.highest_impact_dependency,
                "revenue_at_risk_usd": m.revenue_at_risk_usd,
            },
            indent=2,
        )
    )

    print("=== 3) RECOMMEND ===")
    if args.fixture:
        rec = load_recommend_fixture()
        from cascadeiq.engine.models import MitigationId

        mid = MitigationId(rec["mitigation_id"])
        rationale = rec["rationale"]
        print("inference_used=False (fixture)")
    else:
        try:
            rec_out = recommend_mitigation(scenario, baseline)
            mid = rec_out["mitigation_id"]
            rationale = rec_out["rationale"]
            print("inference_used=True")
        except InferenceError as exc:
            print("INFERENCE_ERROR:", exc)
            return 1
    print("mitigation_id=", mid.value)
    print("rationale=", rationale[:240])

    print("=== 4) VERIFY ===")
    mitigated = run_simulation(scenario, mitigation=mid)
    deltas, overall, notes = compare_results(baseline, mitigated)
    print("overall_improved=", overall)
    print(json.dumps(deltas, indent=2))
    for n in notes:
        print("-", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
