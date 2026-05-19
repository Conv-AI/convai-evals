import type {
  ContextMode,
  ExpectedBehavior,
  RunLlm,
  TestRow,
} from "./types.js";

export const SCENARIO_SCHEMA_VERSION = "convai-evals/v0" as const;

export type ScenarioSchemaVersion = typeof SCENARIO_SCHEMA_VERSION;
export type ScenarioInputKind = "text" | "voice" | "dynamic_context";

export interface EvalScenario {
  schema_version: ScenarioSchemaVersion;
  scenario_id: string;
  title?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sessions: EvalSession[];
}

export interface EvalSession {
  session_id: string;
  metadata?: Record<string, unknown>;
  events: EvalEvent[];
}

export interface EvalEvent {
  event_id: string;
  at_s: number;
  input: ScenarioInput;
  expect?: ScenarioExpectation;
  metadata?: Record<string, unknown>;
}

export type ScenarioInput =
  | { kind: "text"; text: string }
  | { kind: "voice"; text: string; audio_url?: string }
  | {
      kind: "dynamic_context";
      text: string;
      mode?: ContextMode;
      run_llm?: RunLlm;
      current_attention_object?: string;
    };

export interface ScenarioExpectation {
  behavior?: ExpectedBehavior;
  llm_call?: boolean;
  verbal_response?: boolean;
  latency_sla_ms?: number;
  required_events?: string[];
  ai_response_example?: string;
  safety_or_edge_case_tags?: string[];
  semantic_judge?: {
    enabled?: boolean;
    rubric?: string;
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function validateScenario(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });

  if (!isObject(value)) {
    fail("$", "scenario must be an object");
    return { ok: false, issues };
  }

  if (value.schema_version !== SCENARIO_SCHEMA_VERSION) {
    fail("$.schema_version", `must equal ${SCENARIO_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.scenario_id)) {
    fail("$.scenario_id", "must be a non-empty string");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) {
    fail("$.sessions", "must be a non-empty array");
  }

  const eventIds = new Set<string>();
  if (Array.isArray(value.sessions)) {
    value.sessions.forEach((session, sessionIndex) => {
      const sp = `$.sessions[${sessionIndex}]`;
      if (!isObject(session)) {
        fail(sp, "session must be an object");
        return;
      }
      if (!isNonEmptyString(session.session_id)) {
        fail(`${sp}.session_id`, "must be a non-empty string");
      }
      if (!Array.isArray(session.events) || session.events.length === 0) {
        fail(`${sp}.events`, "must be a non-empty array");
        return;
      }
      session.events.forEach((event, eventIndex) => {
        const ep = `${sp}.events[${eventIndex}]`;
        validateEvent(event, ep, fail, eventIds);
      });
    });
  }

  return { ok: issues.length === 0, issues };
}

export function assertScenario(value: unknown): asserts value is EvalScenario {
  const result = validateScenario(value);
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
    throw new Error(`invalid scenario\n${detail}`);
  }
}

export function scenarioToTestRows(scenario: EvalScenario): TestRow[] {
  assertScenario(scenario);
  const rows: TestRow[] = [];
  for (const session of scenario.sessions) {
    session.events.forEach((event, index) => {
      rows.push(eventToTestRow(event, session, index));
    });
  }
  return rows.sort((a, b) =>
    a.session_id === b.session_id
      ? a.sequence_index - b.sequence_index
      : a.session_id.localeCompare(b.session_id),
  );
}

export function explainScenario(scenario: EvalScenario): string {
  assertScenario(scenario);
  const rows = scenarioToTestRows(scenario);
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.input_kind] = (acc[row.input_kind] ?? 0) + 1;
    return acc;
  }, {});
  const tags = scenario.tags?.length ? scenario.tags.join(", ") : "none";
  return [
    `${scenario.scenario_id}: ${scenario.title ?? "Untitled scenario"}`,
    `schema: ${scenario.schema_version}`,
    `sessions: ${scenario.sessions.length}`,
    `events: ${rows.length}`,
    `input mix: voice=${counts["Voice In"] ?? 0}, text=${counts["Text In"] ?? 0}, dynamic_context=${counts["Dynamic Context"] ?? 0}`,
    `tags: ${tags}`,
  ].join("\n");
}

function validateEvent(
  event: unknown,
  path: string,
  fail: (path: string, message: string) => void,
  eventIds: Set<string>,
): void {
  if (!isObject(event)) {
    fail(path, "event must be an object");
    return;
  }
  if (!isNonEmptyString(event.event_id)) {
    fail(`${path}.event_id`, "must be a non-empty string");
  } else if (eventIds.has(event.event_id)) {
    fail(`${path}.event_id`, `duplicate event_id ${event.event_id}`);
  } else {
    eventIds.add(event.event_id);
  }
  if (typeof event.at_s !== "number" || !Number.isFinite(event.at_s) || event.at_s < 0) {
    fail(`${path}.at_s`, "must be a non-negative finite number");
  }
  validateInput(event.input, `${path}.input`, fail);
  validateExpectation(event.expect, `${path}.expect`, fail);
}

function validateInput(
  input: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): void {
  if (!isObject(input)) {
    fail(path, "input must be an object");
    return;
  }
  if (input.kind !== "text" && input.kind !== "voice" && input.kind !== "dynamic_context") {
    fail(`${path}.kind`, "must be one of text, voice, dynamic_context");
    return;
  }
  if (!isNonEmptyString(input.text)) {
    fail(`${path}.text`, "must be a non-empty string");
  }
  if (input.kind === "dynamic_context") {
    if (input.mode != null && input.mode !== "append" && input.mode !== "replace" && input.mode !== "reset") {
      fail(`${path}.mode`, "must be append, replace, or reset");
    }
    if (input.run_llm != null && input.run_llm !== "true" && input.run_llm !== "false" && input.run_llm !== "auto") {
      fail(`${path}.run_llm`, "must be true, false, or auto");
    }
  }
}

function validateExpectation(
  expect: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): void {
  if (expect == null) return;
  if (!isObject(expect)) {
    fail(path, "expect must be an object");
    return;
  }
  if (
    expect.behavior != null &&
    expect.behavior !== "respond" &&
    expect.behavior !== "abstain" &&
    expect.behavior !== "no_call" &&
    expect.behavior !== "respond_with_audio" &&
    expect.behavior !== "respond_silent" &&
    expect.behavior !== "interrupted_by_priority_event"
  ) {
    fail(
      `${path}.behavior`,
      "must be respond, abstain, no_call, respond_with_audio, respond_silent, or interrupted_by_priority_event",
    );
  }
  if (expect.llm_call != null && typeof expect.llm_call !== "boolean") {
    fail(`${path}.llm_call`, "must be boolean");
  }
  if (expect.verbal_response != null && typeof expect.verbal_response !== "boolean") {
    fail(`${path}.verbal_response`, "must be boolean");
  }
  if (expect.latency_sla_ms != null && (typeof expect.latency_sla_ms !== "number" || expect.latency_sla_ms < 0)) {
    fail(`${path}.latency_sla_ms`, "must be a non-negative number");
  }
  if (expect.required_events != null && !isStringArray(expect.required_events)) {
    fail(`${path}.required_events`, "must be an array of strings");
  }
}

function eventToTestRow(event: EvalEvent, session: EvalSession, index: number): TestRow {
  const payload = payloadForInput(event.input);
  const behavior = inferBehavior(event);
  const expectedLlmCall = inferLlmCall(event);
  const verbal = event.expect?.verbal_response ?? behavior === "respond";
  const requiredEvents = event.expect?.required_events?.join("; ");
  const safetyTags = event.expect?.safety_or_edge_case_tags?.join(", ");
  return {
    test_id: event.event_id,
    session_id: session.session_id,
    sequence_index: index + 1,
    timestamp_offset_s: event.at_s,
    input_kind: legacyInputKind(event.input.kind),
    rtvi_payload_json: JSON.stringify(payload),
    expected_response_behavior: behavior,
    expected_llm_call: expectedLlmCall,
    expected_verbal_response: verbal,
    expected_server_events: requiredEvents,
    expected_ai_response_example: event.expect?.ai_response_example,
    safety_or_edge_case_tags: safetyTags,
    input_text: event.input.text,
    current_attention_object:
      event.input.kind === "dynamic_context" ? event.input.current_attention_object : undefined,
    mode: event.input.kind === "dynamic_context" ? event.input.mode : undefined,
    run_llm: event.input.kind === "dynamic_context" ? event.input.run_llm : undefined,
    metadata: mergeMetadata(session.metadata, event.metadata),
  };
}

function payloadForInput(input: ScenarioInput): unknown {
  if (input.kind === "text" || input.kind === "voice") {
    return { type: "user_text_message", data: { text: input.text } };
  }
  return {
    type: "context-update",
    data: compact({
      text: input.text,
      mode: input.mode ?? "append",
      run_llm: input.run_llm ?? "auto",
      current_attention_object: input.current_attention_object,
    }),
  };
}

function inferBehavior(event: EvalEvent): ExpectedBehavior {
  if (event.expect?.behavior) return event.expect.behavior;
  if (event.input.kind === "dynamic_context" && event.input.run_llm === "false") return "no_call";
  return "respond";
}

function inferLlmCall(event: EvalEvent): boolean {
  if (event.expect?.llm_call != null) return event.expect.llm_call;
  if (event.input.kind === "dynamic_context" && event.input.run_llm === "false") return false;
  return true;
}

function legacyInputKind(kind: ScenarioInputKind): TestRow["input_kind"] {
  if (kind === "voice") return "Voice In";
  if (kind === "text") return "Text In";
  return "Dynamic Context";
}

function mergeMetadata(
  sessionMetadata: Record<string, unknown> | undefined,
  eventMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...(sessionMetadata ?? {}), ...(eventMetadata ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
