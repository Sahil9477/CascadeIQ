# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi>=0.115", "uvicorn[standard]>=0.32", "pydantic>=2.9", "openai>=3.51,<4",
#                 "python-dotenv>=1.2.4", "httpx>=0.27", "psycopg[binary]>=3.2"]
# ///
"""CascadeIQ production entry point (Danny). Used on the Linode and for the full local demo.

Imports Sahil's app (cascadeiq.api.main:app) without editing it, then:
  - replaces his /api/runs stubs with the real PostgreSQL persistence (cloud/runs.py)
  - replaces /api/health with one that also reports whether the audit API and database are available
  - serves the dashboard at / and at /runs/{uuid} (read-only saved audits); assets come from /ui (static/)

    uv run serve.py          then open http://localhost:8000      (PORT=80 on the Linode)
"""
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env", override=True)

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from cloud.runs import database_configured, router as runs_router  # noqa: E402
from checks.crosscheck import router as check_router  # noqa: E402
from checks.chart_review import router as chart_router  # noqa: E402

STATIC = ROOT / "static"
AUDIT_API = False
try:
    from cascadeiq.api.main import app

    AUDIT_API = True
except Exception:  # keep the dashboard reachable (offline preview) even if the engine fails to import
    traceback.print_exc()
    app = FastAPI(title="CascadeIQ (dashboard only)")
    print("audit API not loaded; dashboard runs in offline preview mode", file=sys.stderr)

# Routes this file owns. Remove any earlier definitions (Sahil's stubs) so ours are the ones that answer.
OWNED = {"/", "/api/health", "/api/runs", "/api/runs/{run_id}", "/runs/{run_id}"}
app.router.routes = [r for r in app.router.routes if not (isinstance(r, APIRoute) and r.path in OWNED)]
app.include_router(runs_router)
app.include_router(check_router)  # advisory Gemma cross-check of Qwen's extraction
app.include_router(chart_router)  # advisory: Gemma (vision) reads the simulation chart
if not any(getattr(r, "path", None) == "/ui" for r in app.router.routes):
    app.mount("/ui", StaticFiles(directory=STATIC, html=True), name="ui")


@app.get("/api/health")
def health():
    return {"ok": True, "service": "cascadeiq", "audit_api": AUDIT_API, "database": database_configured()}


@app.get("/", include_in_schema=False)
@app.get("/runs/{run_id}", include_in_schema=False)
def dashboard(run_id: str | None = None):
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
