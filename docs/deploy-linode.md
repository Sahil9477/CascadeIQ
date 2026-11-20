# Linode deploy checklist (no provisioning from this doc)

Manual checklist for when Danny / Sahil are ready to put CascadeIQ on a Linode.
**Do not provision** cloud resources from this branch until explicitly approved.

## Before anything

- [ ] Confirm who owns DNS, SSH keys, and billing
- [ ] Confirm secrets live only in server env / secret manager — never in git
- [ ] Confirm Postgres plan (Danny) vs demo-shell-only (static UI + FastAPI)

## Image / host

- [ ] Create Linode (Ubuntu LTS) in the agreed region
- [ ] Harden SSH (keys only, no password root login)
- [ ] Open only 22 / 80 / 443 (or reverse-proxy only)
- [ ] Install Python 3.12+, `uv`, nginx (or Caddy)

## App

- [ ] Clone `https://github.com/Sahil9477/CascadeIQ`
- [ ] Checkout the agreed release branch / tag
- [ ] `cp .env.example .env` and set `AKAMAI_*` on the server only
- [ ] `uv sync --extra dev` (or prod extras if split later)
- [ ] Run: `uv run uvicorn cascadeiq.api.main:app --host 127.0.0.1 --port 8000`
- [ ] Put nginx/Caddy in front; proxy `/` and `/api` to uvicorn
- [ ] Confirm `GET /api/health` and demo shell at `/`

## Optional Postgres (`/api/runs`) — Danny

- [ ] Provision managed or local Postgres
- [ ] Wire connection string via env (not committed)
- [ ] Replace stub `POST /api/runs` + `GET /api/runs/{uuid}`
- [ ] Migration + backup plan before demo day

## Smoke

- [ ] Interpret with `use_fixture=true`
- [ ] Audit chart renders
- [ ] Recommend returns allowlisted mitigation + `inference_used` flag
- [ ] Verify shows before/after deltas
- [ ] Live Qwen path only after keys confirmed working

## Rollback

- [ ] Keep previous git SHA tagged
- [ ] Stop process / revert nginx upstream if health fails
