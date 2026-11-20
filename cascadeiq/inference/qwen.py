"""Akamai Qwen inference helpers (OpenAI-compatible client).

Keys stay in .env — never log or return the API key.
Invalid model JSON → recoverable error; caller may fall back to fixtures
but must set inference_used=False (never fake a successful inference).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import ValidationError

from cascadeiq.engine.models import (
    MITIGATION_ALLOWLIST,
    MitigationId,
    Scenario,
    SimulationResult,
    default_demo_scenario,
)

# Load CascadeIQ .env then workshop .env as fallback (without override if set)
_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_ROOT / ".env", override=False)
load_dotenv(
    Path.home() / "Desktop/akamai-workshop-seattle-hackathon/.env",
    override=False,
)

INTERPRET_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "arrivals_rps": {"type": ["integer", "null"]},
        "payments_capacity_rps": {"type": ["integer", "null"]},
        "fault_start_tick": {"type": ["integer", "null"]},
        "fault_end_tick": {"type": ["integer", "null"]},
        "fault_capacity_rps": {"type": ["integer", "null"]},
        "max_retries": {"type": ["integer", "null"]},
        "ticks": {"type": ["integer", "null"]},
        "missing_fields": {
            "type": "array",
            "items": {"type": "string"},
        },
        "assumptions": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": ["missing_fields", "assumptions"],
    "additionalProperties": False,
}

RECOMMEND_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "mitigation_id": {
            "type": "string",
            "enum": [m["id"] for m in MITIGATION_ALLOWLIST],
        },
        "rationale": {"type": "string"},
    },
    "required": ["mitigation_id", "rationale"],
    "additionalProperties": False,
}


class InferenceError(Exception):
    """Recoverable inference / validation failure."""

    def __init__(self, message: str, raw: Any = None):
        super().__init__(message)
        self.raw = raw


def _client() -> OpenAI:
    for name in ("AKAMAI_BASE_URL", "AKAMAI_API_KEY", "CHAT_MODEL"):
        if not os.environ.get(name):
            raise InferenceError(
                f"{name} is not set. Copy .env.example to .env and add the event key."
            )
    return OpenAI(
        base_url=os.environ["AKAMAI_BASE_URL"],
        api_key=os.environ["AKAMAI_API_KEY"],
    )


def _chat_json(messages: list[dict[str, str]], schema: dict[str, Any], name: str) -> dict:
    client = _client()
    response = client.chat.completions.create(
        model=os.environ["CHAT_MODEL"],
        messages=messages,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": name, "schema": schema},
        },
        max_tokens=800,
        temperature=0.2,
    )
    choice = response.choices[0]
    if choice.finish_reason != "stop":
        raise InferenceError(
            f"Model stopped early ({choice.finish_reason}). Raise max_tokens or retry."
        )
    content = choice.message.content or ""
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise InferenceError(f"Model returned invalid JSON: {exc}", raw=content) from exc


def _merge_interpret(raw: dict[str, Any], source_text: str) -> tuple[Scenario, list[str], str]:
    """Build Scenario from model output; mark missing numeric fields as editable defaults."""
    missing = list(raw.get("missing_fields") or [])
    assumptions = list(raw.get("assumptions") or [])
    editable: list[str] = []

    demo = default_demo_scenario(source_text=source_text)
    data = demo.model_dump()

    def take(field_path: str, raw_key: str, caster=int):
        val = raw.get(raw_key)
        if val is None:
            if raw_key not in missing:
                missing.append(raw_key)
            editable.append(field_path)
            return
        # walk path
        parts = field_path.split(".")
        obj = data
        for p in parts[:-1]:
            obj = obj[p]
        obj[parts[-1]] = caster(val)

    take("arrivals_rps", "arrivals_rps")
    take("capacities.payments_rps", "payments_capacity_rps")
    take("fault.start_tick", "fault_start_tick")
    take("fault.end_tick", "fault_end_tick")
    take("fault.capacity_rps", "fault_capacity_rps")
    take("retry.max_retries", "max_retries")
    take("ticks", "ticks")

    data["assumptions"] = assumptions or demo.assumptions
    data["editable_defaults"] = editable or demo.editable_defaults
    data["source_text"] = source_text
    data["missing_fields_note"] = missing  # not on model; strip via validate

    try:
        scenario = Scenario.model_validate(
            {k: v for k, v in data.items() if k != "missing_fields_note"}
        )
    except ValidationError as exc:
        raise InferenceError(f"Scenario schema validation failed: {exc}", raw=raw) from exc

    status = "ok" if not editable else "ok_with_defaults"
    return scenario, missing, status


def interpret_incident(text: str) -> dict[str, Any]:
    """Call Qwen to extract a scenario. Raises InferenceError on failure."""
    messages = [
        {
            "role": "system",
            "content": (
                "You extract structured resilience-audit scenarios for a fixed "
                "checkout topology: API Gateway → Orders → Payments. "
                "Do NOT invent numeric facts that are not stated or clearly implied. "
                "Put uncertain numeric fields in missing_fields and leave them null. "
                "List short assumptions. Reply only with JSON matching the schema."
            ),
        },
        {
            "role": "user",
            "content": (
                "Extract arrivals/capacity/fault window/retry fields if present.\n\n"
                f"Incident description:\n{text}"
            ),
        },
    ]
    raw = _chat_json(messages, INTERPRET_SCHEMA, "cascadeiq_interpret")
    scenario, missing, status = _merge_interpret(raw, text)
    return {
        "scenario": scenario,
        "missing_fields": missing,
        "validation_status": status,
        "raw_model_output": raw,
    }


def recommend_mitigation(
    scenario: Scenario,
    audit: SimulationResult,
) -> dict[str, Any]:
    """Call Qwen with audit evidence; must return an allowlisted mitigation ID."""
    allow_ids = [m["id"] for m in MITIGATION_ALLOWLIST]
    evidence = {
        "unique_failed_checkouts": audit.metrics.unique_failed_checkouts,
        "unique_successful_checkouts": audit.metrics.unique_successful_checkouts,
        "retry_amplification": audit.metrics.retry_amplification,
        "peak_backlog": audit.metrics.peak_backlog,
        "highest_impact_dependency": audit.metrics.highest_impact_dependency,
        "fault": scenario.fault.model_dump(),
        "retry_policy": scenario.retry.model_dump(),
        "allowlist": MITIGATION_ALLOWLIST,
    }
    messages = [
        {
            "role": "system",
            "content": (
                "You recommend ONE mitigation from the allowlist for a toy "
                "checkout simulation. Reference the computed audit metrics. "
                "Do not invent knobs outside the allowlist. Reply only with JSON."
            ),
        },
        {
            "role": "user",
            "content": (
                "Choose mitigation_id from "
                f"{allow_ids}.\n\nAudit evidence:\n{json.dumps(evidence)}"
            ),
        },
    ]
    raw = _chat_json(messages, RECOMMEND_SCHEMA, "cascadeiq_recommend")
    mid = raw.get("mitigation_id")
    if mid not in allow_ids:
        raise InferenceError(
            f"Mitigation '{mid}' is not allowlisted",
            raw=raw,
        )
    rationale = (raw.get("rationale") or "").strip()
    if not rationale:
        raise InferenceError("Empty rationale from model", raw=raw)
    return {
        "mitigation_id": MitigationId(mid),
        "rationale": rationale,
        "raw_model_output": raw,
    }


def load_interpret_fixture() -> dict[str, Any]:
    path = _ROOT / "fixtures" / "interpret_demo.json"
    return json.loads(path.read_text())


def load_recommend_fixture() -> dict[str, Any]:
    path = _ROOT / "fixtures" / "recommend_demo.json"
    return json.loads(path.read_text())
