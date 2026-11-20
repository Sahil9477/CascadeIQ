"""Qwen's recommendation, informed by Gemma's reading of the chart (Danny).

POST /api/recommend/informed takes the same body as /api/recommend plus an optional `visual_note`
(the text Gemma produced when it read the simulation chart).

- No note, or use_fixture: delegates to Sahil's /api/recommend unchanged.
- With a note: same audit evidence and allowlist as cascadeiq.inference.qwen.recommend_mitigation, plus the
  note as clearly labelled, possibly-wrong context. Qwen must still pick an allowlisted mitigation, and the
  simulator still decides in /api/verify whether it helps.

This mirrors recommend_mitigation's prompt so cascadeiq/ stays untouched; keep the two in step.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import Field

from cascadeiq.api.main import api_recommend
from cascadeiq.engine.models import MITIGATION_ALLOWLIST, MitigationId, RecommendRequest
from cascadeiq.inference import qwen

router = APIRouter()

MAX_NOTE_CHARS = 800


class InformedRecommendRequest(RecommendRequest):
    visual_note: str | None = Field(default=None, max_length=4000)


def recommend_with_visual_note(body: InformedRecommendRequest, note: str) -> dict:
    scenario, audit = body.scenario, body.audit
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
        {"role": "system", "content": (
            "You recommend ONE mitigation from the allowlist for a toy checkout simulation. "
            "Reference the computed audit metrics. Do not invent knobs outside the allowlist. Reply only with JSON. "
            "You may also receive a vision model's reading of the simulation chart. Treat it as a hint that can be "
            "wrong: the computed metrics win if they disagree. If the reading influenced your choice, say so briefly."
        )},
        {"role": "user", "content": (
            f"Choose mitigation_id from {allow_ids}.\n\nAudit evidence:\n{json.dumps(evidence)}\n\n"
            "Chart reading from the vision model (Gemma), may be wrong:\n"
            f"\"\"\"\n{note[:MAX_NOTE_CHARS]}\n\"\"\""
        )},
    ]
    try:
        raw = qwen._chat_json(messages, qwen.RECOMMEND_SCHEMA, "cascadeiq_recommend")
        mid = raw.get("mitigation_id")
        if mid not in allow_ids:
            raise qwen.InferenceError(f"Mitigation '{mid}' is not allowlisted", raw=raw)
        rationale = (raw.get("rationale") or "").strip()
        if not rationale:
            raise qwen.InferenceError("Empty rationale from model", raw=raw)
    except qwen.InferenceError as exc:
        raise HTTPException(422, detail={
            "error": "inference_rejected", "message": str(exc), "allowlist": MITIGATION_ALLOWLIST,
            "hint": "Retry, or pass use_fixture=true (never claim fixture as inference success).",
        }) from exc
    return {
        "mitigation_id": MitigationId(mid).value, "rationale": rationale, "inference_used": True,
        "inference_error": None, "allowlist": MITIGATION_ALLOWLIST, "raw_model_output": raw,
        "visual_note_used": True, "visual_note": note[:MAX_NOTE_CHARS],
    }


@router.post("/api/recommend/informed")
def recommend_informed(body: InformedRecommendRequest):
    note = (body.visual_note or "").strip()
    if body.use_fixture or not note:
        base = api_recommend(RecommendRequest(scenario=body.scenario, audit=body.audit, use_fixture=body.use_fixture))
        return {**base.model_dump(mode="json"), "visual_note_used": False, "visual_note": None}
    return recommend_with_visual_note(body, note)
