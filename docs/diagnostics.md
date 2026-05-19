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

Direct cloud log access is not part of the public default path.
