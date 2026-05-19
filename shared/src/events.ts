// WebSocket message envelopes between orchestrator and control UI (and worker -> orchestrator).
import type { TestRow, RunConfig, ReportPayload, CapturedEvent } from "./types.js";

export type WsServerToClient =
  | { type: "run_started"; run_id: string }
  | { type: "tts_progress"; done: number; total: number; current_text_hash?: string }
  | { type: "tts_complete" }
  | { type: "tts_error"; message: string }
  | { type: "session_started"; session_id: string }
  | { type: "row_dispatched"; session_id: string; test_id: string; sequence_index: number; t: number }
  | { type: "row_event"; session_id: string; test_id: string; event: CapturedEvent }
  | { type: "row_complete"; session_id: string; test_id: string }
  | { type: "session_ended"; session_id: string }
  | { type: "run_canceled"; run_id: string; rows_completed: number; rows_total: number }
  | { type: "run_complete"; report: ReportPayload }
  | { type: "run_error"; message: string };

// Worker -> orchestrator (over a per-worker WS).
export type WsWorkerToOrchestrator =
  | { type: "worker_ready"; session_id: string }
  | { type: "bot_ready"; session_id: string; ts: number }
  | {
      type: "backend_ids";
      session_id: string; // eval session_id (envelope routing key)
      backend: {
        session_id?: string; // server's unique session token from /connect response
        character_session_id?: string; // per-connection interaction id
        character_id: string;
      };
    }
  | { type: "row_dispatched"; session_id: string; test_id: string; sequence_index: number; t: number }
  | { type: "row_event"; session_id: string; test_id: string; event: CapturedEvent }
  | { type: "row_complete"; session_id: string; test_id: string; bot_transcript?: string; user_transcript?: string }
  | { type: "session_ended"; session_id: string }
  | { type: "worker_error"; session_id: string; message: string };

// Orchestrator -> worker.
export type WsOrchestratorToWorker =
  | {
      type: "start_session";
      run_id: string;
      session_id: string;
      config: RunConfig;
      rows: TestRow[];
      // Map of test_id -> URL the worker can fetch the WAV from for Voice In rows.
      voice_wav_urls: Record<string, string>;
    }
  | { type: "stop_session" };

export interface RunStartedPayload {
  config: RunConfig;
  rows: TestRow[];
}
