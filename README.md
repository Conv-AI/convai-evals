# Convai Evals

Agentic evaluation toolkit for Convai Character AI infrastructure.

`convai-evals` is a public, dataset-agnostic runner for testing Convai Character AI behavior through the same customer-facing Web SDK path used by applications. It starts with Web SDK / RTVI coverage for text input, voice input, dynamic context, lipsync events, latency, behavior correctness, and analytics-backed diagnostics. The repo is intentionally independent today and package-shaped so it can later move into a unified Convai agent toolkit or public MCP repo as `packages/evals`.

## Install

```bash
npm install
npm run build
npm test
npm run validate:examples
```

The package name is `@convai/evals` and the CLI binary is `convai-evals`.

## Quickstart

Validate the synthetic public examples:

```bash
convai-evals validate examples/scenarios/*.json
convai-evals explain examples/scenarios/dynamic-context-long-session.json
```

Run the browser-backed local UI:

```bash
npm run build:worker
npm run dev:server
npm run dev:web
```

Then open the Vite URL, load the synthetic sample or upload a CSV adapter file, enter a safe non-customer character ID plus API key, and run the eval. The web dev server is pinned to port 5180 with strict-port mode so it fails loudly instead of silently moving to another app's port. Reports are JSON-first and can be exported as CSV from the UI.

## Scenario Format

The canonical input is versioned JSON:

```json
{
  "schema_version": "convai-evals/v0",
  "scenario_id": "example",
  "sessions": [
    {
      "session_id": "session-001",
      "events": [
        {
          "event_id": "event-001",
          "at_s": 0,
          "input": { "kind": "text", "text": "What should I do next?" },
          "expect": { "behavior": "respond", "llm_call": true, "verbal_response": true }
        }
      ]
    }
  ]
}
```

Supported v0 input kinds are `text`, `voice`, and `dynamic_context`. Domain-specific fields belong in opaque `metadata`; do not add customer-specific columns to the public schema. See [scenario.schema.json](schemas/scenario.schema.json) and [docs/scenario-format.md](docs/scenario-format.md).

Behavior expectations support legacy values `respond`, `abstain`, and `no_call`, plus precise values `respond_with_audio`, `respond_silent`, and `interrupted_by_priority_event`. Legacy `abstain` passes when the server reaches silence through either a silent LLM result or a clean no-call path.

## Web SDK Dependency

This repo does not use a Web SDK submodule. The worker imports `@convai/web-sdk` from npm and exercises:

- `ConvaiClient.connect(...)`
- `sendUserTextMessage(...)`
- `updateContext(...)`
- SDK event listeners such as transcripts, bot output, speaking state, blendshapes, and metrics

The optional `current_attention_object` field is included in the schema but is safe to omit. Use a public SDK version that supports it before making it required in scenarios.

## Diagnostics

Diagnostics are disabled by default:

```bash
DIAG_PROVIDER=none
```

Public v0 supports optional analytics API lookups:

```bash
DIAG_PROVIDER=analytics-api
CONVAI_API_KEY=...
CONVAI_ANALYTICS_BASE_URL=https://analytics-api.convai.com/v1/analytics
```

Reports preserve backend IDs when available so a coding agent can call Convai analytics APIs after a run. Direct cloud log access is intentionally outside the public default path.

Each row also carries a `correlation` block with a deterministic `client_event_id`, dispatch timestamps, and the attribution method used for response and transcript capture. Text and dynamic-context rows attempt to pass the same public-safe metadata through the SDK data message so backend telemetry can join back to eval rows when supported.

## CLI

```bash
convai-evals validate examples/scenarios/*.json
convai-evals convert input.csv --from legacy-rtvi-csv --out scenario.json
convai-evals run scenario.json --out runtime-rows.json
convai-evals report report.json
convai-evals telemetry-ids report.json --out telemetry-ids.json
convai-evals explain scenario.json
convai-evals generate-template --kind voice-text-mix --out scenario.json
```

## Public Safety

The initial public history is meant to be a sanitized first commit: no source history from the precursor repo, no customer datasets, no customer-specific naming, no cloud diagnostics defaults, and no credentials. Synthetic examples preserve workload shapes without customer content.

## License

Apache-2.0.
