export interface AnalyticsApiResult {
  endpoint: string;
  status: number;
  ok: boolean;
  body?: unknown;
  error?: string;
}

export interface DiagnosticsBundle {
  test_id: string;
  run_id: string;
  provider: "analytics-api";
  backend: {
    session_id?: string;
    character_session_id?: string;
    turn_id?: string;
    character_id?: string;
  };
  failure_reason: string;
  analytics_api: {
    session?: AnalyticsApiResult;
    interaction?: AnalyticsApiResult;
    skipped?: string;
  };
  fetch_meta: {
    fetch_duration_ms: number;
    errors: string[];
  };
}
