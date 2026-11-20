"""Smoke POST/GET /api/runs against Managed Postgres (never prints secrets).

Loads .env, builds a verified demo audit, saves via FastAPI TestClient, fetches by uuid.
Exit 0 on success. Requires PGHOST or DATABASE_URL.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=True)

from cascadeiq.engine.models import MitigationId, default_demo_scenario
from cascadeiq.engine.simulator import compare_results, run_simulation
from cloud.runs import database_configured, validate_record
from fastapi.testclient import TestClient


def _record() -> dict:
    sc = default_demo_scenario()
    base = run_simulation(sc)
    mit = run_simulation(sc, mitigation=MitigationId.BOUNDED_EXPONENTIAL_BACKOFF)
    deltas, overall, notes = compare_results(base, mit)
    return json.loads(
        json.dumps(
            {
                "schema_version": "1",
                "scenario": sc.model_dump(mode="json"),
                "interpretation": None,
                "baseline": base.model_dump(mode="json"),
                "mitigated": mit.model_dump(mode="json"),
                "recommendation": {
                    "mitigation_id": MitigationId.BOUNDED_EXPONENTIAL_BACKOFF.value,
                    "inference_used": False,
                },
                "verification": {
                    "deltas": deltas,
                    "overall_improved": overall,
                    "notes": notes,
                },
            }
        )
    )


def main() -> int:
    if not database_configured():
        print("FAIL: database not configured — set PGHOST+PGPASSWORD (or DATABASE_URL) in ~/Desktop/CascadeIQ/.env")
        return 2
    from serve import app

    rec = _record()
    err = validate_record(rec)
    if err:
        print("FAIL: invalid demo record:", err)
        return 1
    client = TestClient(app)
    health = client.get("/api/health").json()
    print("health.database=", health.get("database"))
    save = client.post("/api/runs", json=rec)
    if save.status_code != 201:
        print("FAIL: POST /api/runs", save.status_code, save.text[:200])
        return 1
    payload = save.json()
    run_id = payload["id"]
    got = client.get(f"/api/runs/{run_id}")
    if got.status_code != 200:
        print("FAIL: GET /api/runs/{id}", got.status_code, got.text[:200])
        return 1
    body = got.json()
    assert body.get("id") == run_id
    assert "baseline" in body and "verification" in body
    print(f"OK: saved+fetched id={run_id} url={payload.get('url')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
