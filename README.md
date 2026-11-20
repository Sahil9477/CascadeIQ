# CascadeIQ

Virtual resilience audit: AI interprets an incident → deterministic simulation → AI mitigation → verified rerun.

Hackathon prototype (Akamai Seattle AI Hackathon, Nov 2026).

## Team

- **Sahil** — deterministic simulator, Qwen interpret/recommend, FastAPI audit APIs
- **Danny** — interactive dashboard, Postgres persistence, Linode deploy

## Branch

Active work: `feature/intelligence-engine`

## Setup

```bash
cp .env.example .env   # add AKAMAI_API_KEY
uv sync                # once pyproject exists
uv run uvicorn cascadeiq.api.main:app --reload --port 8000
```

Do not commit `.env` or API keys.
