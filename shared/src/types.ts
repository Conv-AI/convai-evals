// Shared types used by web, server, and worker.

export type InputKind = "Voice In" | "Text In" | "Dynamic Context";
export type ExpectedBehavior =
  | "respond"
  | "abstain"
  | "no_call"
  | "respond_with_audio"
  | "respond_silent"
  | "interrupted_by_priority_event";
export type ObservedBehavior =
  | "respond_with_audio"
  | "respond_silent"
  | "no_call"
  | "interrupted_by_priority_event";
export type FailureReason =
  | "pass"
  | "sla_miss"
  | "interrupted_by_priority_event"
  | "behavior_mismatch_by_design"
  | "behavior_mismatch_error"
  | "timeout"
  | "connection_error";
export type ContextMode = "append" | "replace" | "reset";
export type RunLlm = "true" | "false" | "auto";
export type EndpointKey = "prod" | "preview" | "staging";
export type TtsProvider = "local" | "google";

export function isFailureReasonFailure(reason: FailureReason): boolean {
  return reason !== "pass" &&
    reason !== "interrupted_by_priority_event" &&
    reason !== "behavior_mismatch_by_design";
}

export interface TestRow {
  test_id: string;
  session_id: string;
  sequence_index: number;
  timestamp_offset_s: number;
  input_kind: InputKind;
  rtvi_payload_json: string;
  expected_response_behavior: ExpectedBehavior;
  expected_llm_call: boolean;
  expected_verbal_response: boolean;
  // Optional informational columns. Domain-specific attributes belong in metadata.
  expected_server_events?: string;
  expected_ai_response_example?: string;
  safety_or_edge_case_tags?: string;
  input_text?: string;
  current_attention_object?: string;
  mode?: ContextMode;
  run_llm?: RunLlm;
  context_category?: string;
  context_intent?: string;
  priority?: string;
  metadata?: Record<string, unknown>;
}

export interface RunConfig {
  endpoint: EndpointKey;
  endpointUrl: string;
  characterId: string;
  apiKey: string;
  sessionIds: string[];
  concurrency: number;
  speedMultiplier: number;
  slaVoiceAnimMs: number;
  slaTextOutMs: number;
  judgeEnabled: boolean;
  judgeEveryNth: number;
  judgeApiKey?: string; // optional override for the judge provider API key env var
  ttsProvider: TtsProvider;
  ttsVoiceId: string;
  ttsApiKey?: string; // optional override for the provider's API key env var
  ttsEndpoint?: string; // optional override for the provider's base URL / region
}

export interface RunRequest {
  config: RunConfig;
  rows: TestRow[];
}

// Latency checkpoints captured per row.
export interface RowTimestamps {
  t_input_start?: number;
  t_input_end?: number;
  t_responding_start?: number;
  t_first_bot_output?: number;
  t_responding_end?: number;
  t_tts_started?: number;
  t_speaking_start?: number;
  t_speaking_end?: number;
  t_turn_end?: number;
}

export interface RowLatency {
  ttfb_ms?: number;
  ttfa_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
  end_to_end_ms?: number;
}

export interface CapturedEvent {
  name: string;
  ts: number; // performance.now() in worker
  data?: unknown;
}

export interface RowCorrelation {
  eval_run_id: string;
  eval_session_id: string;
  row_id: string;
  client_event_id: string;
  sequence_index: number;
  input_kind: InputKind;
  dispatch_perf_ms?: number;
  dispatch_epoch_ms?: number;
  input_end_perf_ms?: number;
  input_end_epoch_ms?: number;
  outbound_metadata?: {
    injected: boolean;
    message_type?: string;
  };
  attribution: {
    input: "direct_row" | "voice_owner" | "none";
    response: "response_queue" | "priority_preemption" | "no_response_expected" | "timeout_or_missing";
    transcript: "sdk_message_id" | "sdk_message_queue" | "none";
  };
}

/**
 * Server-emitted per-turn timeline. Comes from core-service utils/turn_trace.flush_turn() when
 * the bot was constructed with debug=true. See models/rtvi.py:653-745 for the source-of-truth shape.
 */
export interface TurnTrace {
  turn_id: string;
  e2e_ms?: number;
  critical_stage?: string;
  critical_stage_ms?: number;
  segments_ms?: Record<string, number>;
  events?: Record<string, number>; // µs relative offsets
  event_timestamps_ms?: Record<string, number>; // absolute ms
  was_canceled?: boolean;
  tags?: Record<string, unknown>;
}

export interface RowObservation {
  test_id: string;
  session_id: string;
  sequence_index: number;
  input_kind: InputKind;
  timestamps: RowTimestamps;
  events: CapturedEvent[];
  bot_transcript?: string;
  user_transcript?: string;
  llm_called: boolean;
  bot_spoke: boolean;
  // Backend identifiers from the server (/connect response + turn-trace) for post-run
  // diagnostics. Nested to avoid colliding with the top-level scenario session_id.
  // NOTE: no per-turn UUID flows over RTVI today — `turn_id` is the server's per-turn
  // identifier (from turn_trace), not a database interaction UUID.
  backend?: {
    session_id?: string; // Server's unique session token from /connect response.
    character_session_id?: string; // Per-connection interaction id from /connect.
    turn_id?: string; // Per-turn id from turn-trace.
    character_id?: string;
  };
  // Server-emitted per-turn breakdown (requires debug=true on connect).
  turn_trace?: TurnTrace;
  was_canceled?: boolean;
  interrupted_by_priority_event?: boolean;
  /** Set when a Dynamic Context row dispatched while a previous bot turn was still
   * in flight. Used by the failure classifier to flag mismatches as "by design". */
  dispatched_mid_turn?: boolean;
  correlation?: RowCorrelation;
}

export interface StructureMatch {
  behavior: boolean;
  llm_call: boolean;
  verbal: boolean;
  events: boolean;
  overall: boolean;
  observed_behavior: ObservedBehavior;
}

export interface JudgeScores {
  relevance: number;
  in_character: number;
  safety: number;
  conciseness: number;
  overall: number;
  rationale: string;
}

export interface DiagnosticsSummary {
  bundle_path: string;
  provider: "analytics-api";
  item_count: number;
  warning_count: number;
  error_count: number;
  skipped?: string;
  errors?: string[];
}

export interface PerRowResult {
  test_id: string;
  session_id: string;
  sequence_index: number;
  input_kind: InputKind;
  expected: {
    behavior: ExpectedBehavior;
    llm_call: boolean;
    verbal: boolean;
    events?: string;
    ai_response_example?: string;
    safety_tags?: string;
    input_text?: string;
  };
  observed: {
    behavior: ObservedBehavior;
    llm_call: boolean;
    verbal: boolean;
    events: string[];
    bot_transcript?: string;
    user_transcript?: string;
  };
  structure_match: StructureMatch;
  timestamps: RowTimestamps;
  latency: RowLatency;
  sla_pass: boolean | null; // null for no_call rows
  judge: JudgeScores | null;
  backend?: {
    session_id?: string;
    character_session_id?: string;
    turn_id?: string;
    character_id?: string;
  };
  correlation?: RowCorrelation;
  turn_trace?: TurnTrace;
  server_e2e_ms?: number;
  was_canceled?: boolean;
  interrupted_by_priority_event?: boolean;
  dispatched_mid_turn?: boolean;
  failure_reason: FailureReason;
  diagnostics?: DiagnosticsSummary;
}

export interface BucketSummary {
  bucket: string;
  total: number;
  structure_passed: number;
  latency_pass_rate: number | null;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
}

export interface IoLatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  sla_pass: boolean | null;
}

export interface TelemetryIdCoverage {
  rows_with_client_event_id: number;
  rows_with_backend_session_id: number;
  rows_with_character_session_id: number;
  rows_with_turn_id: number;
  unique_backend_session_ids: number;
  unique_character_session_ids: number;
  unique_turn_ids: number;
}

export interface ReportPayload {
  run_metadata: {
    run_id: string;
    timestamp: string;
    endpoint: EndpointKey;
    endpointUrl: string;
    characterId: string;
    row_count: number;
    session_count: number;
    concurrency: number;
    speed_multiplier: number;
    sla_voice_anim_ms: number;
    sla_text_out_ms: number;
    judge_enabled: boolean;
    judge_every_nth: number;
    tts_provider: TtsProvider;
    tts_voice_id: string;
    canceled?: boolean;
    partial?: boolean;
  };
  summary: {
    structure_pass_rate_overall: number;
    structure_pass_by_bucket: Record<string, { total: number; passed: number }>;
    latency_by_io_type: Record<string, IoLatencyStats>;
    telemetry_id_coverage: TelemetryIdCoverage;
    judge_mean_scores: JudgeScores | null;
  };
  per_bucket: BucketSummary[];
  per_row: PerRowResult[];
}
