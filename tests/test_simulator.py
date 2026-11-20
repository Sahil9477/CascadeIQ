"""Minimal deterministic simulator tests."""

from __future__ import annotations

import json
from pathlib import Path

from cascadeiq.engine.models import MitigationId, Scenario, default_demo_scenario
from cascadeiq.engine.simulator import compare_results, run_simulation

ROOT = Path(__file__).resolve().parents[1]


def test_demo_fixture_loads():
    data = json.loads((ROOT / "fixtures" / "demo_scenario.json").read_text())
    scenario = Scenario.model_validate(data)
    assert scenario.ticks == 90
    assert scenario.arrivals_rps == 80
    assert scenario.fault.capacity_rps == 30


def test_deterministic_same_seed():
    s = default_demo_scenario()
    a = run_simulation(s)
    b = run_simulation(s)
    assert a.metrics.model_dump() == b.metrics.model_dump()
    assert [t.model_dump() for t in a.series] == [t.model_dump() for t in b.series]


def test_fault_reduces_capacity_in_window():
    s = default_demo_scenario()
    result = run_simulation(s)
    mid = next(t for t in result.series if t.t == 30)
    early = next(t for t in result.series if t.t == 5)
    assert early.payments_capacity == 100
    assert mid.payments_capacity == 30
    assert result.metrics.highest_impact_dependency == "payments"
    # Fault should cause some unique failures under immediate retries
    assert result.metrics.unique_failed_checkouts > 0
    assert result.metrics.total_attempts > 0
    assert len(result.series) == 90


def test_backoff_mitigation_is_deterministic():
    s = default_demo_scenario()
    baseline = run_simulation(s)
    m1 = run_simulation(s, mitigation=MitigationId.BOUNDED_EXPONENTIAL_BACKOFF)
    m2 = run_simulation(s, mitigation=MitigationId.BOUNDED_EXPONENTIAL_BACKOFF)
    assert m1.metrics.model_dump() == m2.metrics.model_dump()
    assert m1.seed == baseline.seed == 42
    deltas, _, _ = compare_results(baseline, m1)
    assert any(d["metric"] == "unique_failed_checkouts" for d in deltas)


def test_retry_cap_reduction_changes_retries():
    s = default_demo_scenario()
    baseline = run_simulation(s)
    mitigated = run_simulation(s, mitigation=MitigationId.RETRY_CAP_REDUCTION)
    assert mitigated.scenario.retry.max_retries == 1
    # Cap reduction should not increase retry count vs baseline
    assert mitigated.metrics.total_retries <= baseline.metrics.total_retries


def test_retry_amplification_reflects_retry_load():
    """Amplification is attempts/originals — never <1 when retries fire.

    Regression: counting only successful payment slots made amp ~0.87 because
    timed-out / overflowed tries never incremented total_attempts.
    """
    s = default_demo_scenario()
    baseline = run_simulation(s)
    m = baseline.metrics
    assert m.total_retries > 0
    assert m.total_attempts >= m.total_retries
    # Every original checkout is enqueued at least once; retries add more attempts
    originals = m.unique_successful_checkouts + m.unique_failed_checkouts
    assert originals > 0
    assert m.total_attempts >= originals
    assert m.retry_amplification >= 1.0
    # Coherent with retry count: amp ≈ 1 + retries/originals
    expected = m.total_attempts / originals
    assert abs(m.retry_amplification - round(expected, 4)) < 1e-9

    mitigated = run_simulation(s, mitigation=MitigationId.BOUNDED_EXPONENTIAL_BACKOFF)
    _, overall, _ = compare_results(baseline, mitigated)
    # Lab 01 demo: backoff still improves primary customer-failure metric
    assert overall is True
    assert mitigated.metrics.unique_failed_checkouts < baseline.metrics.unique_failed_checkouts
    assert mitigated.metrics.retry_amplification >= 1.0
