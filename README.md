# CascadeIQ

Virtual resilience audit: **AI interprets** an incident → **deterministic simulation** → **AI mitigation** → **verified rerun**.

Hackathon prototype (Akamai Seattle AI Hackathon, Nov 2026).

**Repo:** https://github.com/Sahil9477/CascadeIQ  
**Active branch:** `main` (Lab 01 UX: `cursor/lab01-ux-de48`)

## Team

| Owner | Owns |
|---|---|
| **Sahil** | Deterministic simulator, Qwen interpret/recommend, FastAPI `/api/interpret\|audit\|recommend\|verify`, contracts/fixtures, Lab 01 scenario-first UI |
| **Danny** | Full interactive dashboard, Postgres `/api/runs`, Linode deploy |

## Quick start

```bash
cd ~/Desktop/CascadeIQ
git checkout main
cp .env.example .env
# paste AKAMAI_API_KEY from workshop (never commit .env)

uv sync --extra dev
uv run uvicorn cascadeiq.api.main:app --reload --port 8010
# Lab UI:   http://127.0.0.1:8010/
# OpenAPI:  http://127.0.0.1:8010/docs

uv run pytest -q
uv run python scripts/demo_flow.py          # live Qwen + sim
uv run python scripts/demo_flow.py --fixture
```

### Lab 01: The Retry Storm

Open `/` after uvicorn starts. **Start Lab** loads the Gateway→Orders→Payments demo scenario (same fixture path as before). Guided steps: Observe → Predict (local) → Mitigate → Verify → Explain → Share.

Custom incident paste + scenario JSON live under **Advanced / Custom Incident** (collapsed). Other labs show Coming soon. Share calls `POST /api/runs` and surfaces Danny’s Postgres stub honestly (no fake success).

Check **use_fixture** for offline rehearsal (never claim fixture as successful inference — UI shows `inference_used`).

## API (frozen)

See [`docs/cascadeiq-api-contracts.md`](docs/cascadeiq-api-contracts.md) and [`contracts/`](contracts/).

- `POST /api/interpret` — Qwen → scenario JSON
- `POST /api/audit` — baseline sim time series + metrics
- `GET /api/catalog/compute?region=us-sea` — published Linode types (`source: live|unavailable`)
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
static/               # Lab 01 scenario-first shell (Danny owns full dashboard later)
docs/deploy-linode.md # Checklist only — no provisioning
```

Do not commit `.env` or API keys. No billable cloud provisioning from this branch without Sahil approval.
See [`docs/deploy-linode.md`](docs/deploy-linode.md) for a future deploy checklist.
