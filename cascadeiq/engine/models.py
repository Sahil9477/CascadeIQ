"""Shared scenario + metric schemas (frozen for Danny UI)."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class MitigationId(str, Enum):
    """Allowlisted mitigations only — Qwen must pick one of these."""

    BOUNDED_EXPONENTIAL_BACKOFF = "bounded_exponential_backoff_seeded_jitter"
    RETRY_CAP_REDUCTION = "retry_cap_reduction"


MITIGATION_ALLOWLIST: list[dict[str, str]] = [
    {
        "id": MitigationId.BOUNDED_EXPONENTIAL_BACKOFF.value,
        "label": "Bounded exponential backoff with seeded jitter",
        "description": (
            "Keep max retry budget; space retries with exponential backoff "
            "and deterministic seeded jitter instead of immediate retries."
        ),
    },
    {
        "id": MitigationId.RETRY_CAP_REDUCTION.value,
        "label": "Retry cap reduction",
        "description": (
            "Reduce max retries from 2 to 1 to cut retry amplification "
            "during the Payments capacity fault."
        ),
    },
]


class RetryPolicy(BaseModel):
    mode: Literal["immediate", "exponential_backoff"] = "immediate"
    max_retries: int = Field(default=2, ge=0, le=5)
    base_backoff_ticks: int = Field(default=1, ge=1, le=10)
    max_backoff_ticks: int = Field(default=8, ge=1, le=30)
    jitter_fraction: float = Field(default=0.25, ge=0.0, le=1.0)


class FaultWindow(BaseModel):
    service: Literal["payments"] = "payments"
    start_tick: int = Field(default=20, ge=0)
    end_tick: int = Field(default=50, ge=1)
    capacity_rps: int = Field(default=30, ge=0)


class ServiceCapacities(BaseModel):
    gateway_rps: int = Field(default=10_000, ge=1)
    orders_rps: int = Field(default=5_000, ge=1)
    payments_rps: int = Field(default=100, ge=1)


class FinancialAssumptions(BaseModel):
    """Hypothetical editable estimates — always labeled as scenario estimates."""

    revenue_per_checkout_usd: float = Field(default=42.0, ge=0)
    metered_unit_price_usd: float = Field(default=0.0001, ge=0)
    labels: list[str] = Field(
        default_factory=lambda: [
            "scenario estimate",
            "not measured Akamai billing",
            "not a production forecast",
        ]
    )


class TopologyNode(BaseModel):
    id: Literal["gateway", "orders", "payments"]
    label: str


class Scenario(BaseModel):
    """Editable, schema-validated simulation scenario."""

    topology: list[TopologyNode] = Field(
        default_factory=lambda: [
            TopologyNode(id="gateway", label="API Gateway"),
            TopologyNode(id="orders", label="Orders"),
            TopologyNode(id="payments", label="Payments"),
        ]
    )
    ticks: int = Field(default=90, ge=10, le=300)
    arrivals_rps: int = Field(default=80, ge=1)
    capacities: ServiceCapacities = Field(default_factory=ServiceCapacities)
    fault: FaultWindow = Field(default_factory=FaultWindow)
    retry: RetryPolicy = Field(default_factory=RetryPolicy)
    queue_limit: int = Field(default=400, ge=0)
    timeout_ticks: int = Field(default=5, ge=1, le=60)
    seed: int = Field(default=42)
    financial: FinancialAssumptions = Field(default_factory=FinancialAssumptions)
    assumptions: list[str] = Field(default_factory=list)
    editable_defaults: list[str] = Field(default_factory=list)
    source_text: str | None = None

    @field_validator("topology")
    @classmethod
    def _fixed_chain(cls, value: list[TopologyNode]) -> list[TopologyNode]:
        ids = [n.id for n in value]
        if ids != ["gateway", "orders", "payments"]:
            raise ValueError(
                "Only fixed topology Gateway → Orders → Payments is supported"
            )
        return value


class TickMetrics(BaseModel):
    t: int
    arrivals: int
    attempts: int
    completions: int
    backlog: int
    customer_failures: int
    payments_capacity: int
    retries_scheduled: int


class AggregateMetrics(BaseModel):
    unique_successful_checkouts: int
    unique_failed_checkouts: int
    total_attempts: int
    total_completions: int
    total_retries: int
    retry_amplification: float
    peak_backlog: int
    highest_impact_dependency: Literal["gateway", "orders", "payments"]
    revenue_at_risk_usd: float
    incremental_metered_spend_usd: float
    financial_labels: list[str]


class SimulationResult(BaseModel):
    scenario: Scenario
    mitigation_applied: MitigationId | None = None
    series: list[TickMetrics]
    metrics: AggregateMetrics
    seed: int


class InterpretRequest(BaseModel):
    text: str = Field(min_length=1)
    use_fixture: bool = False


class InterpretResponse(BaseModel):
    scenario: Scenario
    missing_fields: list[str]
    validation_status: Literal["ok", "ok_with_defaults", "rejected"]
    inference_used: bool
    inference_error: str | None = None
    raw_model_output: dict[str, Any] | None = None
    source_text: str


class AuditRequest(BaseModel):
    scenario: Scenario


class AuditResponse(BaseModel):
    result: SimulationResult


class RecommendRequest(BaseModel):
    scenario: Scenario
    audit: SimulationResult
    use_fixture: bool = False


class RecommendResponse(BaseModel):
    mitigation_id: MitigationId
    rationale: str
    inference_used: bool
    inference_error: str | None = None
    allowlist: list[dict[str, str]]
    raw_model_output: dict[str, Any] | None = None


class VerifyRequest(BaseModel):
    scenario: Scenario
    mitigation_id: MitigationId
    baseline: SimulationResult | None = None


class MetricDelta(BaseModel):
    metric: str
    baseline: float
    mitigated: float
    delta: float
    improved: bool | None = None


class VerifyResponse(BaseModel):
    baseline: SimulationResult
    mitigated: SimulationResult
    deltas: list[MetricDelta]
    overall_improved: bool
    notes: list[str]


def default_demo_scenario(source_text: str | None = None) -> Scenario:
    return Scenario(
        source_text=source_text
        or (
            "API Gateway → Orders → Payments; Payments slows during peak traffic."
        ),
        assumptions=[
            "Fixed checkout chain Gateway → Orders → Payments.",
            "Illustrative capacities — not measured Akamai behavior.",
            "Baseline: immediate retry, max two retries.",
        ],
        editable_defaults=[
            "arrivals_rps",
            "capacities.payments_rps",
            "fault.start_tick",
            "fault.end_tick",
            "fault.capacity_rps",
            "retry.max_retries",
            "financial.revenue_per_checkout_usd",
            "seed",
        ],
    )


def apply_mitigation(scenario: Scenario, mitigation_id: MitigationId) -> Scenario:
    """Return a copy of scenario with the allowlisted mitigation applied."""
    data = scenario.model_dump()
    retry = dict(data["retry"])
    if mitigation_id == MitigationId.BOUNDED_EXPONENTIAL_BACKOFF:
        retry["mode"] = "exponential_backoff"
        # keep max_retries budget
    elif mitigation_id == MitigationId.RETRY_CAP_REDUCTION:
        retry["max_retries"] = max(0, min(retry.get("max_retries", 2), 1))
        retry["mode"] = "immediate"
    else:
        raise ValueError(f"Mitigation not allowlisted: {mitigation_id}")
    data["retry"] = retry
    return Scenario.model_validate(data)
