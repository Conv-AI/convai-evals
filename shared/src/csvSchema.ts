// Source-of-truth CSV adapter contract for legacy RTVI table imports.
// The canonical public format is the versioned scenario JSON schema.

export interface CsvColumnSpec {
  name: string;
  required: boolean;
  type: "string" | "integer" | "number" | "boolean" | "json" | "enum";
  enumValues?: readonly string[];
  description: string;
  example?: string;
}

export const REQUIRED_COLUMNS: readonly CsvColumnSpec[] = [
  {
    name: "test_id",
    required: true,
    type: "string",
    description: "Unique id for this row within the file.",
    example: "EVAL-001",
  },
  {
    name: "session_id",
    required: true,
    type: "string",
    description: "Groups rows into a single replayed session. One SDK connection per session_id.",
    example: "session-001",
  },
  {
    name: "sequence_index",
    required: true,
    type: "integer",
    description: "Row order within the session.",
    example: "1",
  },
  {
    name: "timestamp_offset_s",
    required: true,
    type: "number",
    description:
      "Firing time in seconds. Per session, the first row's offset is t=0; row K fires at (offset[K] − offset[first]) / speed seconds after session start.",
    example: "15",
  },
  {
    name: "input_kind",
    required: true,
    type: "enum",
    enumValues: ["Voice In", "Text In", "Dynamic Context"] as const,
    description:
      "Voice In rows are spoken by a synthetic mic (TTS-generated audio). Text In rows are sent directly as user_text_message (no TTS/STT). Dynamic Context rows are sent via RTVI context-update.",
    example: "Voice In",
  },
  {
    name: "rtvi_payload_json",
    required: true,
    type: "json",
    description:
      "Full RTVI client message to send. The adapter validates type matches input_kind (user_text_message vs context-update).",
    example: '{"type":"user_text_message","data":{"text":"Hello"}}',
  },
  {
    name: "expected_response_behavior",
    required: true,
    type: "enum",
    enumValues: [
      "respond",
      "abstain",
      "no_call",
      "respond_with_audio",
      "respond_silent",
      "interrupted_by_priority_event",
    ] as const,
    description:
      "Expected high-level behavior. Legacy aliases: respond=respond_with_audio; abstain accepts silent LLM or no LLM.",
    example: "respond",
  },
  {
    name: "expected_llm_call",
    required: true,
    type: "boolean",
    description: "Whether the LLM should be invoked. Accepts TRUE/FALSE/true/false.",
    example: "TRUE",
  },
  {
    name: "expected_verbal_response",
    required: true,
    type: "boolean",
    description: "Whether the bot should speak. Accepts TRUE/FALSE/true/false.",
    example: "TRUE",
  },
];

export const OPTIONAL_COLUMNS: readonly CsvColumnSpec[] = [
  {
    name: "expected_server_events",
    required: false,
    type: "string",
    description: "Semicolon- or space-separated list of substrings to match against captured event names.",
    example: "server-response;bot-turn-completed",
  },
  {
    name: "expected_ai_response_example",
    required: false,
    type: "string",
    description: "Exemplar bot response. Used by the LLM judge if enabled.",
  },
  {
    name: "safety_or_edge_case_tags",
    required: false,
    type: "string",
    description: "Comma-separated tags fed into the judge safety axis (e.g. responsible_play).",
  },
  {
    name: "input_text",
    required: false,
    type: "string",
    description: "Spoken text for Voice In rows. Required when input_kind=Voice In.",
  },
  {
    name: "current_attention_object",
    required: false,
    type: "string",
    description: "Passed to context-update for Dynamic Context rows (requires SDK >= 1.3.3-beta.0).",
  },
  {
    name: "mode",
    required: false,
    type: "enum",
    enumValues: ["append", "replace", "reset"] as const,
    description: "Context-update mode.",
  },
  {
    name: "run_llm",
    required: false,
    type: "enum",
    enumValues: ["true", "false", "auto"] as const,
    description: "Context-update run_llm directive.",
  },
  { name: "context_category", required: false, type: "string", description: "For filtering/display." },
  { name: "context_intent", required: false, type: "string", description: "For filtering/display." },
  { name: "priority", required: false, type: "string", description: "For filtering/display." },
  {
    name: "metadata_json",
    required: false,
    type: "json",
    description: "Opaque scenario metadata. Organization-specific columns should be mapped into this object.",
    example: '{"persona":"returning-user","surface":"mobile"}',
  },
];

export const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS] as const;

export function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "y";
}
