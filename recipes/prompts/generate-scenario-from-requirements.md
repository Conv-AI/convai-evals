# Generate Scenario From Requirements

Convert the requirement into `schema_version: "convai-evals/v0"` JSON. Keep organization-specific details out of top-level fields and put generic attributes in `metadata`. Include realistic timestamp spacing, one or more sessions, deterministic `event_id` values, and explicit expectations for behavior, model calls, verbal response, latency, and required events. Validate the output with `convai-evals validate`.
