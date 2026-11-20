"""CascadeIQ FastAPI — Sahil intelligence engine endpoints.

Danny owns UI under static/ and optional Postgres /api/runs persistence.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from cascadeiq.engine.models import (
    MITIGATION_ALLOWLIST,
    AuditRequest,
    AuditResponse,
    InterpretRequest,
    InterpretResponse,
    RecommendRequest,
    RecommendResponse,
    VerifyRequest,
    VerifyResponse,
    MetricDelta,
    default_demo_scenario,
)
from cascadeiq.engine.simulator import compare_results, run_simulation
from cascadeiq.inference.qwen import (
    InferenceError,
    interpret_incident,
    load_interpret_fixture,
    load_recommend_fixture,
    recommend_mitigation,
)

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "static"

app = FastAPI(
    title="CascadeIQ",
    version="0.1.0",
    description="AI interpretation → deterministic resilience audit → verified mitigation",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "cascadeiq", "version": "0.1.0"}


@app.get("/api/mitigations")
def list_mitigations():
    return {"allowlist": MITIGATION_ALLOWLIST}


@app.post("/api/interpret", response_model=InterpretResponse)
def api_interpret(body: InterpretRequest):
    """Qwen → validated editable scenario + missing_fields + validation status."""
    if body.use_fixture:
        fix = load_interpret_fixture()
        scenario = default_demo_scenario(source_text=body.text).model_copy(
            update=fix.get("scenario_overrides", {})
        )
        # Rebuild from fixture scenario if provided fully
        if "scenario" in fix:
            from cascadeiq.engine.models import Scenario

            scenario = Scenario.model_validate(fix["scenario"])
            scenario.source_text = body.text
        return InterpretResponse(
            scenario=scenario,
            missing_fields=fix.get("missing_fields", []),
            validation_status=fix.get("validation_status", "ok_with_defaults"),
            inference_used=False,
            inference_error="Fixture path requested — not presented as successful inference.",
            raw_model_output=fix.get("raw_model_output"),
            source_text=body.text,
        )

    try:
        result = interpret_incident(body.text)
        return InterpretResponse(
            scenario=result["scenario"],
            missing_fields=result["missing_fields"],
            validation_status=result["validation_status"],
            inference_used=True,
            inference_error=None,
            raw_model_output=result["raw_model_output"],
            source_text=body.text,
        )
    except InferenceError as exc:
        # Recoverable: return demo scenario with error flagged (not fake success)
        demo = default_demo_scenario(source_text=body.text)
        return InterpretResponse(
            scenario=demo,
            missing_fields=[
                "arrivals_rps",
                "payments_capacity_rps",
                "fault_start_tick",
                "fault_end_tick",
                "fault_capacity_rps",
            ],
            validation_status="ok_with_defaults",
            inference_used=False,
            inference_error=str(exc),
            raw_model_output=getattr(exc, "raw", None)
            if isinstance(getattr(exc, "raw", None), dict)
            else None,
            source_text=body.text,
        )


@app.post("/api/audit", response_model=AuditResponse)
def api_audit(body: AuditRequest):
    """Deterministic baseline simulation → time series + metrics."""
    result = run_simulation(body.scenario, mitigation=None)
    return AuditResponse(result=result)


@app.post("/api/recommend", response_model=RecommendResponse)
def api_recommend(body: RecommendRequest):
    """Qwen with audit evidence → allowlisted mitigation ID + rationale."""
    if body.use_fixture:
        fix = load_recommend_fixture()
        from cascadeiq.engine.models import MitigationId

        return RecommendResponse(
            mitigation_id=MitigationId(fix["mitigation_id"]),
            rationale=fix["rationale"],
            inference_used=False,
            inference_error="Fixture path requested — not presented as successful inference.",
            allowlist=MITIGATION_ALLOWLIST,
            raw_model_output=fix.get("raw_model_output"),
        )

    try:
        result = recommend_mitigation(body.scenario, body.audit)
        return RecommendResponse(
            mitigation_id=result["mitigation_id"],
            rationale=result["rationale"],
            inference_used=True,
            inference_error=None,
            allowlist=MITIGATION_ALLOWLIST,
            raw_model_output=result["raw_model_output"],
        )
    except InferenceError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "inference_rejected",
                "message": str(exc),
                "allowlist": MITIGATION_ALLOWLIST,
                "hint": "Retry, or pass use_fixture=true (never claim fixture as inference success).",
            },
        ) from exc


@app.post("/api/verify", response_model=VerifyResponse)
def api_verify(body: VerifyRequest):
    """Same scenario+seed with mitigation → deltas vs baseline."""
    baseline = body.baseline or run_simulation(body.scenario, mitigation=None)
    # Force identical seed
    if baseline.seed != body.scenario.seed:
        raise HTTPException(
            status_code=400,
            detail="Baseline seed must match scenario.seed for verification.",
        )
    mitigated = run_simulation(body.scenario, mitigation=body.mitigation_id)
    raw_deltas, overall, notes = compare_results(baseline, mitigated)
    deltas = [MetricDelta.model_validate(d) for d in raw_deltas]
    return VerifyResponse(
        baseline=baseline,
        mitigated=mitigated,
        deltas=deltas,
        overall_improved=overall,
        notes=notes,
    )


@app.post("/api/runs")
def api_runs_stub(payload: dict):
    """Stretch: Danny's Postgres persistence. Stub only — does not claim save succeeded."""
    return {
        "status": "not_implemented",
        "message": (
            "POST /api/runs is Danny's PostgreSQL stretch goal. "
            "Intelligence engine leaves this stub for import compatibility."
        ),
        "received_keys": sorted(payload.keys()),
    }


@app.get("/api/runs/{run_id}")
def api_runs_get_stub(run_id: str):
    return {
        "status": "not_implemented",
        "run_id": run_id,
        "message": "Read-only /runs/{uuid} is Danny's ownership (Postgres).",
    }


# Static UI shell for Danny — do not overwrite existing index.html if present
if STATIC.exists():
    index = STATIC / "index.html"
    if index.exists():

        @app.get("/")
        def index_page():
            return FileResponse(index)

    app.mount("/ui", StaticFiles(directory=str(STATIC), html=True), name="ui")
