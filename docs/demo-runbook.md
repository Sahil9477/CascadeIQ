# Demo runbook (Danny)

## Run it

```bash
cp .env.example .env      # AKAMAI_API_KEY + the PG* lines from deploy/PROVISIONING.md
uv run serve.py           # http://localhost:8000
```

Use `serve.py`, not `uvicorn cascadeiq.api.main:app`: only `serve.py` has the real `/api/runs` and `/runs/{uuid}`.
The UI is Sahil's demo shell (`static/index.html`, `demo.js`, `demo.css`); `serve.py` adds saving and `/runs/{uuid}`.

## Before judging (10 minutes)

- [ ] `curl http://<IP>/api/health` → `audit_api: true`, `database: true`
- [ ] Open `http://<IP>/` on a phone on **cellular**, not venue Wi-Fi (proves the firewall lets judges in)
- [ ] Run the full flow once with live Qwen; save it; keep the `/runs/<uuid>` link as the backup if inference fails live
- [ ] Untick **Use fixtures instead of live inference** and check both steps show `inference_used=true` (header lamp turns lime). If either shows `false`, say so out loud; never present it as AI output

## 90-second script

1. **Problem (10 s).** "When a dependency slows down, naive retries can turn a partial slowdown into a checkout outage. Engineers can't safely test that in production."
2. **Interpret (15 s).** Paste the incident → *Interpret with Qwen*. Point at `validation=…`, `inference_used=true`, and any missing fields filled with defaults.
3. **Audit (20 s).** *Run resilience audit*. The path animates: Payments goes red when the fault hits, back-pressure runs up to Orders, the clock and hatched fault window show when. Scrub the timeline to any second.
4. **Recommend (15 s).** *Ask Qwen for a mitigation*. The diagnostic report shows analyst (live or fixture), finding, rationale and the raw model output. Qwen picks one of the two allowlisted mitigations and explains why.
5. **Verify (15 s).** *Verify in simulator*. The path replays with the fix; the outcome strip shows before → after in large type. Read it honestly, including red deltas.
6. **Share (5 s).** *Save and get share link* → open it on a phone. "Postgres stores every verified audit, so the result is reproducible and shareable."

## Akamai services to name

| Service | What it does here |
|---|---|
| Linode | Hosts the public dashboard and API |
| Akamai Inference (Qwen) | Two calls: incident → validated scenario; audit evidence → allowlisted mitigation |
| Managed PostgreSQL | Stores verified audits behind shareable read-only `/runs/{uuid}` links |
| Cloud Firewall | Web open for judges, SSH limited to the team |

## Say plainly

- All failures are simulated in code; nothing real is disrupted.
- Capacities, prices and revenue are illustrative assumptions, not measured Akamai behavior or real bills.
