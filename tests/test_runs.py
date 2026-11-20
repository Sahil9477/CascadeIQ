"""Validation tests for saved audits (Danny's cloud/runs.py). Run: uv run --extra dev --with "psycopg[binary]" python -m pytest"""
import copy
import json

import pytest

pytest.importorskip("psycopg")
from cloud.runs import validate_record  # noqa: E402

from cascadeiq.engine.models import MitigationId, default_demo_scenario  # noqa: E402
from cascadeiq.engine.simulator import compare_results, run_simulation  # noqa: E402


def _demo_record():
    sc = default_demo_scenario()
    base = run_simulation(sc)
    mit = run_simulation(sc, mitigation=MitigationId.BOUNDED_EXPONENTIAL_BACKOFF)
    deltas, overall, notes = compare_results(base, mit)
    return json.loads(json.dumps({
        "schema_version": "1", "scenario": sc.model_dump(mode="json"), "interpretation": None,
        "baseline": base.model_dump(mode="json"), "mitigated": mit.model_dump(mode="json"),
        "recommendation": {"mitigation_id": MitigationId.BOUNDED_EXPONENTIAL_BACKOFF.value, "inference_used": False},
        "verification": {"deltas": deltas, "overall_improved": overall, "notes": notes},
    }))


DEMO = _demo_record()


def test_demo_record_is_valid():
    assert validate_record(DEMO) is None


@pytest.mark.parametrize("key", ["scenario", "baseline", "mitigated", "recommendation", "verification"])
def test_missing_section_rejected(key):
    rec = copy.deepcopy(DEMO)
    rec.pop(key)
    assert key in validate_record(rec)


def test_seed_mismatch_rejected():
    rec = copy.deepcopy(DEMO)
    rec["mitigated"]["seed"] = rec["baseline"]["seed"] + 1
    assert "same seed" in validate_record(rec)


def test_non_object_rejected():
    assert validate_record([1, 2]) == "body must be a JSON object"
