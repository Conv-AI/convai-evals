# Agent Workflows

Convai Evals is designed to be easy for coding agents to inspect and operate.

For a new requirement, generate or edit a scenario first, then run `convai-evals validate`. Validation errors use stable JSON paths so an agent can patch only the broken field.

For runtime debugging, use `convai-evals run scenario.json --out rows.json` to inspect the exact rows that will be replayed by the browser runner. Then execute the local UI/server path and export the JSON report.

For latency or behavior regressions, compare two report JSON files by `test_id`, `failure_reason`, `structure_match`, and `latency.end_to_end_ms`. Keep JSON as the source of truth and derive CSV/HTML views after the fact.

For backend investigation, enable `DIAG_PROVIDER=analytics-api` or use backend IDs from the report to call Convai analytics APIs in a separate workflow.
