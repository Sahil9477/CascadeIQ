"""Deterministic Gateway → Orders → Payments checkout simulator.

Illustrative toy model for hackathon demos — not measured production behavior.
Same seed + scenario always yields identical series and aggregates.
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field

from .models import (
    AggregateMetrics,
    MitigationId,
    Scenario,
    SimulationResult,
    TickMetrics,
    apply_mitigation,
)


@dataclass
class Request:
    customer_id: int
    attempt: int  # 0 = original, 1..max_retries = retries
    ready_tick: int
    enqueued_tick: int | None = None


@dataclass
class EngineState:
    backlog: deque[Request] = field(default_factory=deque)
    scheduled: list[Request] = field(default_factory=list)
    success_customers: set[int] = field(default_factory=set)
    failed_customers: set[int] = field(default_factory=set)
    seen_customers: set[int] = field(default_factory=set)
    total_attempts: int = 0
    total_completions: int = 0
    total_retries: int = 0
    peak_backlog: int = 0
    next_customer_id: int = 1


def _payments_capacity(scenario: Scenario, t: int) -> int:
    fault = scenario.fault
    if fault.start_tick <= t < fault.end_tick:
        return fault.capacity_rps
    return scenario.capacities.payments_rps


def _effective_upstream(scenario: Scenario) -> int:
    """Gateway/Orders are not the bottleneck in the demo topology."""
    return min(scenario.capacities.gateway_rps, scenario.capacities.orders_rps)


def _backoff_delay(scenario: Scenario, attempt: int, rng: random.Random) -> int:
    """Ticks until a retry becomes ready. attempt is 1-based retry number."""
    if scenario.retry.mode == "immediate":
        return 0
    base = scenario.retry.base_backoff_ticks
    delay = min(
        scenario.retry.max_backoff_ticks,
        base * (2 ** max(0, attempt - 1)),
    )
    if scenario.retry.jitter_fraction > 0:
        span = max(0.0, delay * scenario.retry.jitter_fraction)
        jitter = rng.uniform(-span, span)
        delay = max(0, int(round(delay + jitter)))
    return delay


def _admit_arrivals(state: EngineState, scenario: Scenario, t: int) -> int:
    n = scenario.arrivals_rps
    for _ in range(n):
        cid = state.next_customer_id
        state.next_customer_id += 1
        state.seen_customers.add(cid)
        state.scheduled.append(Request(customer_id=cid, attempt=0, ready_tick=t))
    return n


def _release_ready(state: EngineState, t: int) -> None:
    still: list[Request] = []
    for req in state.scheduled:
        if req.ready_tick <= t:
            req.enqueued_tick = t
            state.backlog.append(req)
        else:
            still.append(req)
    state.scheduled = still


def _schedule_retry(
    state: EngineState,
    scenario: Scenario,
    req: Request,
    t: int,
    rng: random.Random,
) -> None:
    delay = _backoff_delay(scenario, req.attempt, rng)
    state.scheduled.append(
        Request(
            customer_id=req.customer_id,
            attempt=req.attempt,
            ready_tick=t + delay,
        )
    )
    state.total_retries += 1


def run_simulation(
    scenario: Scenario,
    mitigation: MitigationId | None = None,
) -> SimulationResult:
    if mitigation is not None:
        scenario = apply_mitigation(scenario, mitigation)

    rng = random.Random(scenario.seed)
    state = EngineState()
    series: list[TickMetrics] = []

    for t in range(scenario.ticks):
        arrivals = _admit_arrivals(state, scenario, t)
        _release_ready(state, t)

        # Timeouts before processing this tick's capacity
        # Re-schedule timed-out items that still have retry budget with proper backoff
        timed_out_failures = 0
        kept: deque[Request] = deque()
        pending_retry: list[Request] = []
        while state.backlog:
            req = state.backlog.popleft()
            assert req.enqueued_tick is not None
            if t - req.enqueued_tick >= scenario.timeout_ticks:
                if req.attempt < scenario.retry.max_retries:
                    pending_retry.append(
                        Request(
                            customer_id=req.customer_id,
                            attempt=req.attempt + 1,
                            ready_tick=t,
                        )
                    )
                else:
                    if (
                        req.customer_id not in state.success_customers
                        and req.customer_id not in state.failed_customers
                    ):
                        state.failed_customers.add(req.customer_id)
                        timed_out_failures += 1
            else:
                kept.append(req)
        state.backlog = kept
        retries_scheduled = 0
        for req in pending_retry:
            _schedule_retry(state, scenario, req, t, rng)
            retries_scheduled += 1

        pay_cap = _payments_capacity(scenario, t)
        upstream = _effective_upstream(scenario)
        capacity = min(pay_cap, upstream)

        attempts = 0
        completions = 0
        # Process up to capacity from backlog (FIFO)
        processed = 0
        remaining: deque[Request] = deque()
        while state.backlog and processed < capacity:
            req = state.backlog.popleft()
            attempts += 1
            processed += 1
            state.total_attempts += 1
            # Successful payment for this attempt
            completions += 1
            state.total_completions += 1
            if req.customer_id not in state.success_customers:
                state.success_customers.add(req.customer_id)
                state.failed_customers.discard(req.customer_id)

        # Any leftover stays queued; overflow beyond queue_limit fails or retries
        while state.backlog:
            remaining.append(state.backlog.popleft())

        overflow_failures = 0
        if len(remaining) > scenario.queue_limit:
            overflow = len(remaining) - scenario.queue_limit
            for _ in range(overflow):
                req = remaining.pop()  # drop newest
                if req.attempt < scenario.retry.max_retries:
                    next_req = Request(
                        customer_id=req.customer_id,
                        attempt=req.attempt + 1,
                        ready_tick=t,
                    )
                    _schedule_retry(state, scenario, next_req, t, rng)
                    retries_scheduled += 1
                else:
                    if (
                        req.customer_id not in state.success_customers
                        and req.customer_id not in state.failed_customers
                    ):
                        state.failed_customers.add(req.customer_id)
                        overflow_failures += 1

        state.backlog = remaining
        state.peak_backlog = max(state.peak_backlog, len(state.backlog))

        series.append(
            TickMetrics(
                t=t,
                arrivals=arrivals,
                attempts=attempts,
                completions=completions,
                backlog=len(state.backlog),
                customer_failures=timed_out_failures + overflow_failures,
                payments_capacity=pay_cap,
                retries_scheduled=retries_scheduled,
            )
        )

    # End-of-run: anything still pending counts as failed if never succeeded
    for req in list(state.backlog) + list(state.scheduled):
        if (
            req.customer_id not in state.success_customers
            and req.customer_id not in state.failed_customers
        ):
            state.failed_customers.add(req.customer_id)

    unique_success = len(state.success_customers)
    unique_failed = len(state.failed_customers)
    total_customers = len(state.seen_customers)
    # Ensure accounting closes (success + failed == seen, after discarding overlaps)
    # A customer in both shouldn't happen; prefer success.
    state.failed_customers -= state.success_customers
    unique_failed = len(state.failed_customers)

    retry_amp = (
        state.total_attempts / max(1, total_customers)
    )

    fin = scenario.financial
    revenue_at_risk = unique_failed * fin.revenue_per_checkout_usd
    # Extra metered units ≈ total attempts beyond unique customers (retries + overload)
    extra_units = max(0, state.total_attempts - total_customers)
    incremental_spend = extra_units * fin.metered_unit_price_usd

    metrics = AggregateMetrics(
        unique_successful_checkouts=unique_success,
        unique_failed_checkouts=unique_failed,
        total_attempts=state.total_attempts,
        total_completions=state.total_completions,
        total_retries=state.total_retries,
        retry_amplification=round(retry_amp, 4),
        peak_backlog=state.peak_backlog,
        highest_impact_dependency="payments",
        revenue_at_risk_usd=round(revenue_at_risk, 2),
        incremental_metered_spend_usd=round(incremental_spend, 6),
        financial_labels=list(fin.labels),
    )

    return SimulationResult(
        scenario=scenario,
        mitigation_applied=mitigation,
        series=series,
        metrics=metrics,
        seed=scenario.seed,
    )


def compare_results(
    baseline: SimulationResult,
    mitigated: SimulationResult,
) -> tuple[list[dict], bool, list[str]]:
    """Compute deltas; overall_improved if fewer unique failures (primary)."""
    b, m = baseline.metrics, mitigated.metrics
    pairs = [
        ("unique_failed_checkouts", b.unique_failed_checkouts, m.unique_failed_checkouts, True),
        ("unique_successful_checkouts", b.unique_successful_checkouts, m.unique_successful_checkouts, False),
        ("retry_amplification", b.retry_amplification, m.retry_amplification, True),
        ("peak_backlog", b.peak_backlog, m.peak_backlog, True),
        ("total_retries", b.total_retries, m.total_retries, True),
        ("revenue_at_risk_usd", b.revenue_at_risk_usd, m.revenue_at_risk_usd, True),
    ]
    deltas = []
    for name, bv, mv, lower_better in pairs:
        delta = float(mv) - float(bv)
        if abs(delta) < 1e-12:
            improved = None
        else:
            improved = (delta < 0) if lower_better else (delta > 0)
        deltas.append(
            {
                "metric": name,
                "baseline": float(bv),
                "mitigated": float(mv),
                "delta": round(delta, 6),
                "improved": improved,
            }
        )

    overall = m.unique_failed_checkouts < b.unique_failed_checkouts or (
        m.unique_failed_checkouts == b.unique_failed_checkouts
        and m.retry_amplification < b.retry_amplification
    )
    notes = [
        "Primary success criterion: fewer unique failed checkouts.",
        "Financial figures are scenario estimates, not real cloud bills.",
    ]
    if not overall:
        notes.append(
            "Mitigation did not improve the primary customer-failure metric; reported honestly."
        )
    return deltas, overall, notes
