import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type {
  BucketSummary,
  IoLatencyStats,
  JudgeScores,
  PerRowResult,
  ReportPayload,
  RowObservation,
  RunConfig,
  RunRequest,
  TestRow,
  WsServerToClient,
} from "@convai/evals-shared";
import { TtsService } from "../tts/TtsService.js";
import { WorkerHandle } from "./WorkerHandle.js";
import { runAllSessions } from "./WorkerPool.js";
import { checkStructure } from "../analysis/StructureCheck.js";
import { computeLatency, rowSlaPass, summarizeLatency } from "../analysis/LatencyAnalysis.js";
import { classifyFailure } from "../analysis/FailureClassifier.js";
import { judge } from "../judge.js";
import { collectForRun } from "../diagnostics/DiagnosticsCollector.js";
import { loadDiagConfig } from "../diagnostics/config.js";

export interface CoordinatorDeps {
  tts: TtsService;
  workerPageUrl: string;
  orchestratorWsUrl: string;
  ttsCacheServePath: (cacheKey: string) => string;
  /** When a worker connects, the coordinator needs to hand its WS to the right WorkerHandle. */
  registerWorkerSocketHandler: (sessionId: string, runId: string, handler: (ws: WebSocket) => void) => void;
  unregisterWorkerSocketHandler: (sessionId: string, runId: string) => void;
  perSessionTimeoutMs?: number;
}

export interface RunOptions {
  /** Lets the caller observe the assigned runId and grow its handle list as sessions launch. */
  onRunId?: (runId: string) => void;
  registerHandle?: (handle: WorkerHandle) => void;
  signal?: AbortSignal;
}

export class RunCoordinator {
  constructor(private deps: CoordinatorDeps) {}

  async run(req: RunRequest, controlWs: WebSocket | null, options: RunOptions = {}): Promise<ReportPayload> {
    const runId = randomUUID();
    options.onRunId?.(runId);
    this.emit(controlWs, { type: "run_started", run_id: runId });

    // 1) Filter rows by selected session_ids
    const rows = req.rows.filter((r) => req.config.sessionIds.includes(r.session_id));
    if (rows.length === 0) throw new Error("No rows match the selected session_ids");

    // 2) TTS pre-generation phase for Voice In rows
    const voiceRows = rows.filter((r) => r.input_kind === "Voice In" && (r.input_text ?? "").trim() !== "");
    const overrides = {
      apiKey: req.config.ttsApiKey,
      endpoint: req.config.ttsEndpoint,
    };
    const ttsRequests = voiceRows.map((r) => ({
      text: r.input_text!.trim(),
      voiceId: req.config.ttsVoiceId,
      provider: req.config.ttsProvider,
      overrides,
    }));

    let cacheKeyByTestId: Map<string, string> = new Map();
    try {
      const results = await this.deps.tts.preGenerate(ttsRequests, {
        concurrency: 10,
        onProgress: (done, total, key) => {
          this.emit(controlWs, { type: "tts_progress", done, total, current_text_hash: key });
        },
      });
      // Map test_id -> cacheKey
      for (const r of voiceRows) {
        const key = this.deps.tts.cacheKey({
          text: r.input_text!.trim(),
          voiceId: req.config.ttsVoiceId,
          provider: req.config.ttsProvider,
          overrides,
        });
        if (results.has(key)) cacheKeyByTestId.set(r.test_id, key);
      }
      this.emit(controlWs, { type: "tts_complete" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit(controlWs, { type: "tts_error", message });
      throw e;
    }

    // 3) Group rows by session_id and launch a WorkerHandle per session
    const bySession = new Map<string, TestRow[]>();
    for (const r of rows) {
      if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
      bySession.get(r.session_id)!.push(r);
    }
    for (const [, arr] of bySession) arr.sort((a, b) => a.sequence_index - b.sequence_index);

    const handles: WorkerHandle[] = [];
    for (const [sessionId, sessionRows] of bySession) {
      const voiceWavUrls: Record<string, string> = {};
      for (const r of sessionRows) {
        const key = cacheKeyByTestId.get(r.test_id);
        if (key) voiceWavUrls[r.test_id] = this.deps.ttsCacheServePath(key);
      }
      const handle = new WorkerHandle({
        runId,
        sessionId,
        config: req.config,
        rows: sessionRows,
        voiceWavUrls,
        workerPageUrl: this.deps.workerPageUrl,
        orchestratorWsUrl: this.deps.orchestratorWsUrl,
        onMessage: (msg) => {
          if (msg.type === "row_event") {
            this.emit(controlWs, {
              type: "row_event",
              session_id: msg.session_id,
              test_id: msg.test_id,
              event: msg.event,
            });
          } else if (msg.type === "row_dispatched") {
            this.emit(controlWs, {
              type: "row_dispatched",
              session_id: msg.session_id,
              test_id: msg.test_id,
              sequence_index: msg.sequence_index,
              t: msg.t,
            });
          } else if (msg.type === "row_complete") {
            this.emit(controlWs, {
              type: "row_complete",
              session_id: msg.session_id,
              test_id: msg.test_id,
            });
          } else if (msg.type === "session_ended") {
            this.emit(controlWs, { type: "session_ended", session_id: msg.session_id });
          }
        },
      });
      handles.push(handle);
      options.registerHandle?.(handle);

      this.deps.registerWorkerSocketHandler(sessionId, runId, (ws) => handle.attachWs(ws));
    }

    const perSessionTimeoutMs = this.deps.perSessionTimeoutMs ?? defaultSessionTimeoutMs(rows);

    try {
      this.emit(controlWs, { type: "session_started", session_id: "*" });
      await runAllSessions(handles, req.config.concurrency, perSessionTimeoutMs, options.signal);
    } finally {
      for (const h of handles) this.deps.unregisterWorkerSocketHandler(h.sessionId, runId);
    }

    const canceled = options.signal?.aborted === true;

    // 4) Build report. When canceled, include only rows that actually dispatched.
    const observations = handles.flatMap((h) => Array.from(h.observations.values()));
    const obsById = new Map(observations.map((o) => [o.test_id, o]));
    const reportRows = canceled
      ? rows.filter((row) => obsById.get(row.test_id)?.timestamps.t_input_start != null)
      : rows;
    const perRow: PerRowResult[] = reportRows.map((row) =>
      buildPerRow(row, obsById.get(row.test_id), req.config),
    );

    // 5) Optional judge phase — skip when canceled to avoid LLM spend on a partial dataset.
    if (req.config.judgeEnabled && !canceled) {
      await judgeRows(perRow, req.config.judgeEveryNth, req.config.judgeApiKey);
    }

    // 6) Diagnostics: optional analytics API lookups. Soft-fail — never breaks the run.
    const diagCfg = loadDiagConfig();
    if (diagCfg.enabled) {
      const diagnosticsDir = path.join(process.cwd(), "diagnostics", runId);
      try {
        await collectForRun(perRow, runId, handles, diagCfg, diagnosticsDir);
      } catch (e) {
        console.error("[diag] collection failed (non-fatal):", e instanceof Error ? e.message : String(e));
      }
    }

    const report = assembleReport(runId, perRow, req.config, {
      canceled,
      partial: canceled && perRow.length < rows.length,
    });

    if (canceled) {
      this.emit(controlWs, {
        type: "run_canceled",
        run_id: runId,
        rows_completed: perRow.length,
        rows_total: rows.length,
      });
    }
    this.emit(controlWs, { type: "run_complete", report });
    return report;
  }

  private emit(ws: WebSocket | null, msg: WsServerToClient): void {
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }
}

function defaultSessionTimeoutMs(rows: TestRow[]): number {
  if (rows.length === 0) return 60_000;
  const offsets = rows.map((r) => r.timestamp_offset_s);
  const max = Math.max(...offsets);
  const min = Math.min(...offsets);
  const span = (max - min) * 1000;
  // 60s buffer at end for trailing responses + 30% slack on the schedule
  return Math.ceil(span * 1.3) + 60_000;
}

function buildPerRow(row: TestRow, obs: RowObservation | undefined, config: RunConfig): PerRowResult {
  const fallbackObs: RowObservation = obs ?? {
    test_id: row.test_id,
    session_id: row.session_id,
    sequence_index: row.sequence_index,
    input_kind: row.input_kind,
    timestamps: {},
    events: [],
    llm_called: false,
    bot_spoke: false,
  };
  const structure_match = checkStructure(row, fallbackObs);
  const latency = computeLatency(fallbackObs.timestamps);
  const partial: PerRowResult = {
    test_id: row.test_id,
    session_id: row.session_id,
    sequence_index: row.sequence_index,
    input_kind: row.input_kind,
    expected: {
      behavior: row.expected_response_behavior,
      llm_call: row.expected_llm_call,
      verbal: row.expected_verbal_response,
      events: row.expected_server_events,
      ai_response_example: row.expected_ai_response_example,
      safety_tags: row.safety_or_edge_case_tags,
      input_text: row.input_text,
    },
    observed: {
      behavior: structure_match.observed_behavior,
      llm_call: fallbackObs.llm_called,
      verbal: fallbackObs.bot_spoke,
      events: fallbackObs.events.map((e) => e.name),
      bot_transcript: fallbackObs.bot_transcript,
      user_transcript: fallbackObs.user_transcript,
    },
    structure_match,
    timestamps: fallbackObs.timestamps,
    latency,
    sla_pass: null,
    judge: null,
    backend: fallbackObs.backend ? { ...fallbackObs.backend } : undefined,
    turn_trace: fallbackObs.turn_trace,
    server_e2e_ms: fallbackObs.turn_trace?.e2e_ms,
    was_canceled: fallbackObs.was_canceled,
    dispatched_mid_turn: fallbackObs.dispatched_mid_turn,
    failure_reason: "pass",
  };
  partial.sla_pass = rowSlaPass(partial, config.slaVoiceAnimMs, config.slaTextOutMs);
  partial.failure_reason = classifyFailure(row, fallbackObs, structure_match, partial.sla_pass);
  return partial;
}

async function judgeRows(rows: PerRowResult[], everyNth: number, apiKey?: string): Promise<void> {
  const respondRows = rows.filter((r) => r.structure_match.observed_behavior === "respond");
  const sampled = respondRows.filter((_, idx) => idx % Math.max(1, everyNth) === 0);
  const concurrency = 10;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, sampled.length) }, async () => {
    while (cursor < sampled.length) {
      const myIdx = cursor++;
      const row = sampled[myIdx];
      if (!row) break;
      try {
        const result = await judge({
          input_text: row.expected.input_text ?? "",
          expected_example: row.expected.ai_response_example,
          observed_text: row.observed.bot_transcript ?? "",
          safety_tags: row.expected.safety_tags,
          apiKey,
        });
        row.judge = result;
      } catch (e) {
        // Soft-fail per row; surface as a rationale string only
        row.judge = {
          relevance: 0,
          in_character: 0,
          safety: 0,
          conciseness: 0,
          overall: 0,
          rationale: `judge error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
  });
  await Promise.all(workers);
}

function assembleReport(
  runId: string,
  perRow: PerRowResult[],
  config: RunConfig,
  flags: { canceled: boolean; partial: boolean } = { canceled: false, partial: false },
): ReportPayload {
  const bucketKeys = ["voice_in_true", "text_in_true", "dyn_true", "dyn_auto", "dyn_false"];
  const byBucket: Record<string, { total: number; passed: number }> = {};
  for (const k of bucketKeys) byBucket[k] = { total: 0, passed: 0 };
  for (const r of perRow) {
    const key = bucketKeyFor(r);
    if (!byBucket[key]) byBucket[key] = { total: 0, passed: 0 };
    byBucket[key].total += 1;
    if (r.structure_match.overall) byBucket[key].passed += 1;
  }

  const overall_passed = perRow.filter((r) => r.structure_match.overall).length;
  const latencyByIo = summarizeLatency(perRow, config.slaVoiceAnimMs, config.slaTextOutMs);

  const judgeScored = perRow.filter((r) => r.judge && r.judge.overall > 0);
  const judgeMean = judgeScored.length
    ? meanScores(judgeScored.map((r) => r.judge as JudgeScores))
    : null;

  const per_bucket = buildBucketSummaries(perRow);

  return {
    run_metadata: {
      run_id: runId,
      timestamp: new Date().toISOString(),
      endpoint: config.endpoint,
      endpointUrl: config.endpointUrl,
      characterId: config.characterId,
      row_count: perRow.length,
      session_count: new Set(perRow.map((r) => r.session_id)).size,
      concurrency: config.concurrency,
      speed_multiplier: config.speedMultiplier,
      sla_voice_anim_ms: config.slaVoiceAnimMs,
      sla_text_out_ms: config.slaTextOutMs,
      judge_enabled: config.judgeEnabled,
      judge_every_nth: config.judgeEveryNth,
      tts_provider: config.ttsProvider,
      tts_voice_id: config.ttsVoiceId,
      canceled: flags.canceled,
      partial: flags.partial,
    },
    summary: {
      structure_pass_rate_overall: perRow.length === 0 ? 0 : overall_passed / perRow.length,
      structure_pass_by_bucket: byBucket,
      latency_by_io_type: latencyByIo,
      judge_mean_scores: judgeMean,
    },
    per_bucket,
    per_row: perRow,
  };
}

function bucketKeyFor(row: PerRowResult): string {
  if (row.input_kind === "Voice In") return "voice_in_true";
  if (row.input_kind === "Text In") return "text_in_true";
  // Dynamic Context — use run_llm if present in the payload
  try {
    const parsed = JSON.parse(row.expected.input_text ?? "") as { data?: { run_llm?: string } };
    // Not actually the payload — leave to event-based heuristic
    void parsed;
  } catch {
    // ignore
  }
  // Derive from expected_llm_call + expected_verbal_response combo as a fallback
  if (row.expected.llm_call && row.expected.verbal) return "dyn_true";
  if (row.expected.llm_call && !row.expected.verbal) return "dyn_auto";
  return "dyn_false";
}

function buildBucketSummaries(rows: PerRowResult[]): BucketSummary[] {
  const groups = new Map<string, PerRowResult[]>();
  for (const r of rows) {
    const k = bucketKeyFor(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return Array.from(groups.entries()).map(([bucket, arr]) => {
    const passed = arr.filter((r) => r.structure_match.overall).length;
    const lats = arr
      .map((r) => r.latency.end_to_end_ms)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const slaPasses = arr.filter((r) => r.sla_pass === true).length;
    const slaTotal = arr.filter((r) => r.sla_pass !== null).length;
    return {
      bucket,
      total: arr.length,
      structure_passed: passed,
      latency_pass_rate: slaTotal === 0 ? null : slaPasses / slaTotal,
      p50_ms: lats.length ? lats[Math.floor(lats.length * 0.5)] : undefined,
      p95_ms: lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : undefined,
      p99_ms: lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.99))] : undefined,
    };
  });
}

function meanScores(scores: JudgeScores[]): JudgeScores {
  const sum = (k: keyof Pick<JudgeScores, "relevance" | "in_character" | "safety" | "conciseness" | "overall">) =>
    scores.reduce((a, s) => a + s[k], 0) / scores.length;
  return {
    relevance: sum("relevance"),
    in_character: sum("in_character"),
    safety: sum("safety"),
    conciseness: sum("conciseness"),
    overall: sum("overall"),
    rationale: `mean of ${scores.length} judged rows`,
  };
}

// Persist a final report JSON for offline inspection (optional helper).
export async function writeReportToDisk(report: ReportPayload, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `report-${report.run_metadata.run_id}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}
