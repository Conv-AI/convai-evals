# Compare Prod And Preview

Run the same scenario once against preview and once against prod. Compare JSON reports by `test_id`. Highlight changes in `failure_reason`, `structure_match.overall`, `latency.end_to_end_ms`, `server_e2e_ms`, and transcript availability. Treat missing analytics data as non-fatal, but preserve backend IDs so a follow-up agent can investigate.
