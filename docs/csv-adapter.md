# CSV Adapter

The canonical format is scenario JSON, but v0 keeps a CSV adapter for existing RTVI-style tables.

Use:

```bash
convai-evals convert input.csv --from legacy-rtvi-csv --out scenario.json
convai-evals validate scenario.json
```

Required columns are:

`test_id`, `session_id`, `sequence_index`, `timestamp_offset_s`, `input_kind`, `rtvi_payload_json`, `expected_response_behavior`, `expected_llm_call`, and `expected_verbal_response`.

`expected_response_behavior` accepts the legacy values `respond`, `abstain`, and `no_call`. It also accepts precise values `respond_with_audio`, `respond_silent`, and `interrupted_by_priority_event`. Legacy `respond` is scored as `respond_with_audio`; legacy `abstain` accepts either silent LLM handling or a clean no-call path.

Optional domain-specific columns should be converted into `metadata_json`. This lets private datasets stay private while preserving workload shape in public scenarios.
