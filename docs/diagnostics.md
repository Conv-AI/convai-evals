# Diagnostics

Diagnostics are opt-in. The default is:

```bash
DIAG_PROVIDER=none
```

Set `DIAG_PROVIDER=analytics-api` to ask the runner to preserve backend IDs and perform best-effort lookups through the public analytics API:

```bash
DIAG_PROVIDER=analytics-api
CONVAI_API_KEY=...
CONVAI_ANALYTICS_BASE_URL=https://analytics-api.convai.com/v1/analytics
```

Missing API keys, missing backend IDs, 404s, and unavailable analytics data are written into per-row diagnostic bundles without failing the eval run. This makes the report useful for coding agents: they can inspect `backend.session_id`, `backend.character_session_id`, and `backend.turn_id`, then decide whether to call analytics APIs, rerun with diagnostics enabled, or compare a saved report with another run.

Every run also writes a `correlation` block per row. It includes the eval `run_id`, scenario `session_id`, `test_id`, a deterministic `client_event_id`, dispatch timestamps, and the attribution method used for input, response, and transcript capture. For text and dynamic-context rows, the browser worker also tries to attach this metadata to outbound SDK data messages; unsupported backends can ignore those extra fields safely.

To extract the IDs and dispatch time window for an external telemetry lookup:

```bash
convai-evals telemetry-ids report.json --out telemetry-ids.json
```
