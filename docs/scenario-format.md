# Scenario Format

The canonical v0 input format is `schema_version: "convai-evals/v0"`. A scenario contains one or more sessions, and each session contains timestamped events.

Each event has an `input` block with `kind: "text"`, `kind: "voice"`, or `kind: "dynamic_context"`. Text and voice inputs are converted to `user_text_message`; dynamic context inputs are converted to `updateContext` with `mode`, `run_llm`, and optional `current_attention_object`.

Expectations are intentionally generic:

- `behavior`: `respond`, `abstain`, or `no_call`, with precise aliases `respond_with_audio`, `respond_silent`, and `interrupted_by_priority_event`
- `llm_call`: whether a model call is expected
- `verbal_response`: whether audible bot output is expected
- `latency_sla_ms`: event-level SLA target
- `required_events`: SDK event names that should appear
- `semantic_judge`: optional rubric for agentic scoring

Domain-specific information belongs in `metadata`. This keeps the public repo input-dataset agnostic while still supporting workload shapes such as long sessions, mixed voice/text input, dynamic-context state changes, and preview/prod comparisons.

`respond` is treated as the legacy alias for `respond_with_audio`. `abstain` means no audible response and passes whether the server reached silence through a silent LLM result or by skipping the LLM entirely.
