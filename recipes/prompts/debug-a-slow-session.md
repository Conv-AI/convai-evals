# Debug A Slow Session

Use the report JSON as the source of truth. Find rows with high `latency.end_to_end_ms`, then inspect `turn_trace`, `server_e2e_ms`, `backend.session_id`, `backend.character_session_id`, and `failure_reason`. If diagnostics are missing, rerun with `DIAG_PROVIDER=analytics-api` or call the analytics API using the preserved backend IDs. Return a ranked bottleneck list and one concrete next action per row.
