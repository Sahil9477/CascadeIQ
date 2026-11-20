# CascadeIQ API contracts (frozen v1)

For Danny UI + Sahil intelligence engine. Base URL locally: `http://127.0.0.1:8000`.

Mitigation allowlist (only):

1. `bounded_exponential_backoff_seeded_jitter`
2. `retry_cap_reduction`

Demo scenario defaults (PDF): 90 ticks, 80 rps arrivals, Payments 100→30 during t=20–50, baseline immediate retry max 2, seed 42.

---

## `POST /api/interpret`

**Request**

```json
{
  "text": "API Gateway → Orders → Payments; Payments slows during peak…",
  "use_fixture": false
}
```

**Response**

```json
{
  "scenario": { "...": "see fixtures/demo_scenario.json" },
  "missing_fields": ["arrivals_rps"],
  "validation_status": "ok_with_defaults",
  "inference_used": true,
  "inference_error": null,
  "raw_model_output": {},
  "source_text": "…"
}
```

`validation_status`: `ok` | `ok_with_defaults` | `rejected`  
If inference fails: `inference_used=false`, `inference_error` set, demo defaults returned — **never claim fixture/fallback as successful inference**.

---

## `POST /api/audit`

**Request:** `{ "scenario": <Scenario> }`  
**Response:** `{ "result": { "series": [...], "metrics": {...}, "seed": 42 } }`

`series[t]` fields: `t`, `arrivals`, `attempts`, `completions`, `backlog`, `customer_failures`, `payments_capacity`, `retries_scheduled`.

`metrics` fields: `unique_successful_checkouts`, `unique_failed_checkouts`, `total_attempts`, `total_completions`, `total_retries`, `retry_amplification`, `peak_backlog`, `highest_impact_dependency`, `revenue_at_risk_usd`, `incremental_metered_spend_usd`, `financial_labels`.

---

## `POST /api/recommend`

**Request:** `{ "scenario": <Scenario>, "audit": <SimulationResult>, "use_fixture": false }`  
**Response:**

```json
{
  "mitigation_id": "bounded_exponential_backoff_seeded_jitter",
  "rationale": "…references computed metrics…",
  "inference_used": true,
  "inference_error": null,
  "allowlist": […],
  "raw_model_output": {}
}
```

Invalid / non-allowlisted model output → HTTP 422 (recoverable).

---

## `POST /api/verify`

**Request:** `{ "scenario": <Scenario>, "mitigation_id": "<allowlisted>", "baseline": <optional SimulationResult> }`  
**Response:** `{ "baseline", "mitigated", "deltas", "overall_improved", "notes" }`

Same seed/fault/workload; mitigation applied in Python only.

---

## `POST /api/runs` (stretch — Danny)

Stub returns `status: not_implemented`. Do not claim Postgres persistence until Danny wires it.

---

## Curl happy path

```bash
cd ~/Desktop/CascadeIQ
cp .env.example .env   # add AKAMAI_API_KEY from workshop
uv sync --extra dev
uv run uvicorn cascadeiq.api.main:app --reload --port 8000

# 1) interpret
curl -s localhost:8000/api/interpret -H 'content-type: application/json' \
  -d @fixtures/interpret_request.json | jq '{validation_status,inference_used,missing_fields}'

# 2) audit
curl -s localhost:8000/api/audit -H 'content-type: application/json' \
  -d @fixtures/audit_request.json | jq '.result.metrics'

# 3) recommend (pipe audit into recommend — see scripts/demo_flow.py)
# 4) verify with returned mitigation_id
```

Fixtures for offline UI work: `fixtures/interpret_demo.json`, `fixtures/recommend_demo.json`, `fixtures/demo_scenario.json`.
