# CascadeIQ

Virtual resilience audit: **AI interprets** an incident → **deterministic simulation** → **AI mitigation** → **verified rerun**.

Hackathon prototype (Akamai Seattle AI Hackathon, Nov 2026).

**Repo:** https://github.com/Sahil9477/CascadeIQ  
**Active branch:** `main` (demo shell: `feature/demo-shell`)

## Team

| Owner | Owns |
|---|---|
| **Sahil** | Deterministic simulator, Qwen interpret/recommend, FastAPI `/api/interpret\|audit\|recommend\|verify`, contracts/fixtures, minimal demo shell |
| **Danny** | Full interactive dashboard, Postgres `/api/runs`, Linode deploy |

## Quick start

```bash
cd ~/Desktop/CascadeIQ
git checkout main   # or feature/demo-shell
cp .env.example .env
# paste AKAMAI_API_KEY from workshop (never commit .env)

uv sync --extra dev
uv run uvicorn cascadeiq.api.main:app --reload --port 8010
# Demo UI:  http://127.0.0.1:8010/
# OpenAPI:  http://127.0.0.1:8010/docs

uv run pytest -q
uv run python scripts/demo_flow.py          # live Qwen + sim
uv run python scripts/demo_flow.py --fixture
```

### 90s demo shell

Open `/` after uvicorn starts. Flow: paste incident → **Interpret** → edit scenario → **Run audit** (chart) → **Recommend** → pick allowlisted mitigation → **Verify** before/after.

Check **use_fixture** for offline rehearsal (never claim fixture as successful inference — UI shows `inference_used`).

## API (frozen)

See [`docs/cascadeiq-api-contracts.md`](docs/cascadeiq-api-contracts.md) and [`contracts/`](contracts/).

- `POST /api/interpret` — Qwen → scenario JSON
- `POST /api/audit` — baseline sim time series + metrics
- `POST /api/recommend` — Qwen allowlisted mitigation
- `POST /api/verify` — same seed + mitigation deltas
- `POST /api/runs` — Danny stub

Mitigations allowlist only: `bounded_exponential_backoff_seeded_jitter` | `retry_cap_reduction`.

## Layout

```
cascadeiq/engine/     # simulator + schemas
cascadeiq/inference/  # Akamai Qwen client
cascadeiq/api/        # FastAPI
contracts/ fixtures/  # Danny-unblocking contracts
static/               # Minimal dark demo shell (Danny owns full dashboard later)
docs/deploy-linode.md # Checklist only — no provisioning
```

Do not commit `.env` or API keys. No billable cloud provisioning from this branch without Sahil approval.
See [`docs/deploy-linode.md`](docs/deploy-linode.md) for a future deploy checklist.
