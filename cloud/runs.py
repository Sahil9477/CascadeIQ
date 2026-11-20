"""Saved audits in Akamai Managed PostgreSQL: POST /api/runs, GET /api/runs/{uuid}.

Each verified audit is stored once, as an immutable JSON document, and gets a shareable read-only URL /runs/{uuid}.
Connection settings come from the standard PG* variables in .env (PGHOST, PGPORT, PGUSER, PGPASSWORD,
PGDATABASE, PGSSLMODE), the same ones the workshop's 03-database lab uses. Without PGHOST the endpoints return 503
and the rest of the app keeps working.
"""
import json
import os
import uuid

import psycopg
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

router = APIRouter()

MAX_BYTES = 2_000_000
REQUIRED = ("scenario", "baseline", "mitigated", "recommendation", "verification")
RUN_KEYS = ("series", "metrics", "seed")  # Sahil's SimulationResult

SCHEMA = """
create table if not exists audit_runs (
    id uuid primary key,
    created_at timestamptz not null default now(),
    schema_version text not null,
    outcome text,
    record jsonb not null
)
"""


def database_configured() -> bool:
    return bool(os.environ.get("PGHOST"))


def _connect():
    return psycopg.connect(connect_timeout=10)


_ready = False


def _ensure_schema():
    global _ready
    if _ready:
        return
    with _connect() as conn:
        conn.execute(SCHEMA)
    _ready = True


def validate_record(rec) -> str | None:
    """Return an error message, or None if the record is a complete verified audit."""
    if not isinstance(rec, dict):
        return "body must be a JSON object"
    missing = [k for k in REQUIRED if not rec.get(k)]
    if missing:
        return "not a verified audit, missing: " + ", ".join(missing)
    for name in ("baseline", "mitigated"):
        run = rec[name]
        if not isinstance(run, dict) or any(k not in run for k in RUN_KEYS):
            return f"{name} must contain {', '.join(RUN_KEYS)}"
    if not isinstance(rec["scenario"], dict) or "seed" not in rec["scenario"]:
        return "scenario must include its seed so the run is reproducible"
    if rec["baseline"]["seed"] != rec["mitigated"]["seed"]:
        return "baseline and mitigated runs must use the same seed"
    if not isinstance(rec["verification"], dict) or "overall_improved" not in rec["verification"]:
        return "verification must include overall_improved"
    return None


@router.post("/api/runs", status_code=201)
async def save_run(request: Request):
    if not database_configured():
        raise HTTPException(503, "Saving is unavailable: the database is not configured on this server.")
    body = await request.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, f"audit is larger than {MAX_BYTES} bytes")
    try:
        rec = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(400, "body is not valid JSON")
    error = validate_record(rec)
    if error:
        raise HTTPException(422, error)
    run_id = uuid.uuid4()
    try:
        _ensure_schema()
        with _connect() as conn:
            conn.execute(
                "insert into audit_runs (id, schema_version, outcome, record) values (%s, %s, %s, %s)",
                (run_id, str(rec.get("schema_version", "1")), "improved" if rec["verification"]["overall_improved"] else "not_improved", Jsonb(rec)),
            )
    except psycopg.OperationalError as e:
        raise HTTPException(503, f"database unreachable: {e.__class__.__name__}")
    return JSONResponse({"id": str(run_id), "url": f"/runs/{run_id}"}, status_code=201)


@router.get("/api/runs/{run_id}")
def get_run(run_id: str):
    try:
        key = uuid.UUID(run_id)
    except ValueError:
        raise HTTPException(404, "no such audit")
    if not database_configured():
        raise HTTPException(503, "the database is not configured on this server")
    try:
        _ensure_schema()
        with _connect() as conn:
            row = conn.execute("select record, created_at from audit_runs where id = %s", (key,)).fetchone()
    except psycopg.OperationalError as e:
        raise HTTPException(503, f"database unreachable: {e.__class__.__name__}")
    if not row:
        raise HTTPException(404, "no such audit")
    record, created_at = row
    return {**record, "id": str(key), "created_at": created_at.isoformat()}
