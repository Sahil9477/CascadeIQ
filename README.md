# CascadeIQ

Virtual resilience audit: **AI interprets** an incident → **deterministic simulation** → **AI mitigation** → **verified rerun**.

Hackathon prototype (Akamai Seattle AI Hackathon, Nov 2026).

**Repo:** https://github.com/Sahil9477/CascadeIQ  
**Demo:** http://127.0.0.1:8000/ (`uv run serve.py`)  
**Active branch:** `main`

## Judging

```text
User and task: CS / cloud students (and judges) learning why retry storms break checkout paths; they run Lab 01, see the outage, pick a mitigation, and verify it.
Benefit: Turns an abstract SRE failure into a hands-on lab: AI proposes, deterministic sim proves, shareable /runs/{uuid} for grading.
Services: Akamai Inference (Qwen interpret + recommend; Gemma chart review); Managed Postgres (persist audit runs / share links); Linode Types API (published compute pricing beside outage loss). App can run on a Linode VM (deploy/) — laptop demo uses serve.py.
Inference: qwen3-8-27b for scenario JSON + allowlisted mitigation; gemma-4-26b-a4b-it reads the before chart as a hint (metrics win). Checked by same-seed Python verify and fixture vs live flags (inference_used).
Technical choice: Simulator owns truth — models never invent metrics; allowlist + re-sim with same seed so AI can’t fake a win.
Our idea: Scenario-first teaching lab (Build → Cost → Break → Fix → Learn), two-model diagnose with Python as the judge.
Demo: Start Lab → untick fixtures → Run audit → Ask Qwen → Verify → Save → open /runs/{uuid}.
Known limits: No public Linode app URL until Nanode is provisioned; shared minute token budget (429); retry_cap_reduction may show clearer wins than backoff alone.
```

## Team

| Owner | Owns |
|---|---|
| **Sahil** | Deterministic simulator, Qwen interpret/recommend, FastAPI `/api/interpret\|audit\|recommend\|verify`, contracts/fixtures, Lab 01 + catalog/cost panel |
| **Danny** | Interactive dashboard (`static/` instrument), Postgres `/api/runs`, `serve.py`, Linode `deploy/` |

## Quick start

```bash
cd ~/Desktop/CascadeIQ
git checkout main
cp .env.example .env
# paste AKAMAI_API_KEY + PG* from workshop / Cloud Manager (never commit .env)

uv sync --extra dev
uv run serve.py
# Lab UI:   http://127.0.0.1:8000/
# OpenAPI:  http://127.0.0.1:8000/docs
# Health:   http://127.0.0.1:8000/api/health

# Engine-only (no Postgres overlay): 
# uv run uvicorn cascadeiq.api.main:app --reload --port 8010

uv run pytest -q
uv run python scripts/demo_flow.py          # live Qwen + sim
uv run python scripts/demo_flow.py --fixture
uv run python scripts/smoke_runs_db.py      # POST/GET /api/runs when PG* set
```

### Lab 01: The Retry Storm

Open `/` after `serve.py` starts. **Start Lab** loads the Gateway→Orders→Payments demo. Leave **Use fixtures** unticked for live Qwen/Gemma; tick it for offline rehearsal (`inference_used` is always shown honestly).

Flow: Start Lab → **Run resilience audit** → **Ask Qwen for a mitigation** (Gemma chart review → informed recommend) → **Verify** → **Save** → open `/runs/{uuid}`.

Play streams the audit timeline only after a baseline exists. Cost panel uses published Linode types (`GET /api/catalog/compute?region=us-sea`) beside simulated outage loss — never invents prices.

## API

See [`docs/cascadeiq-api-contracts.md`](docs/cascadeiq-api-contracts.md) and [`contracts/`](contracts/).

- `POST /api/interpret` — Qwen → scenario JSON
- `POST /api/audit` — baseline sim time series + metrics
- `GET /api/catalog/compute?region=us-sea` — published Linode types (`source: live|unavailable`)
- `POST /api/chart/review` — Gemma reads the chart (advisory)
- `POST /api/recommend` / `POST /api/recommend/informed` — allowlisted mitigation (optional visual note)
- `POST /api/verify` — same seed + mitigation deltas
- `POST /api/runs` · `GET /api/runs/{uuid}` — Postgres persist + share (via `serve.py`)

Mitigations allowlist only: `bounded_exponential_backoff_seeded_jitter` | `retry_cap_reduction`.

## Layout

```
cascadeiq/engine/     # simulator + schemas
cascadeiq/inference/  # Akamai Qwen client
cascadeiq/api/        # FastAPI intelligence endpoints
checks/               # Gemma chart review + informed recommend (Danny)
cloud/                # Postgres /api/runs (Danny)
serve.py              # production entry: app + runs + static
static/               # Lab UI + instrument
deploy/               # Linode service + deploy.sh
contracts/ fixtures/
```

Do not commit `.env` or API keys. See [`deploy/PROVISIONING.md`](deploy/PROVISIONING.md) for Linode + Managed Postgres checklist.
