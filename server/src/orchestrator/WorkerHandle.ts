import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { WebSocket } from "ws";
import type {
  CapturedEvent,
  RowObservation,
  RunConfig,
  TestRow,
  TurnTrace,
  WsOrchestratorToWorker,
  WsWorkerToOrchestrator,
} from "@convai/evals-shared";

export interface WorkerHandleOptions {
  runId: string;
  sessionId: string;
  config: RunConfig;
  rows: TestRow[];
  /** Per-test_id URL the worker fetches the pre-generated WAV from. */
  voiceWavUrls: Record<string, string>;
  /** URL the orchestrator serves the worker bundle (html + js) from. */
  workerPageUrl: string;
  /** WS URL the worker connects back to. */
  orchestratorWsUrl: string;
  onMessage: (msg: WsWorkerToOrchestrator) => void;
}

export class WorkerHandle {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  readonly observations = new Map<string, RowObservation>();
  readonly sessionId: string;
  private finished = false;
  private resolveDone!: () => void;
  private rejectDone!: (e: Error) => void;
  private donePromise: Promise<void>;
  private workerWs?: WebSocket;
  /** Wall-clock anchor captured when bot_ready arrives; used to convert performance.now() timestamps to epoch-ms. */
  wallClockAnchor?: { wallMs: number; perfNow: number };

  constructor(private opts: WorkerHandleOptions) {
    this.sessionId = opts.sessionId;
    this.donePromise = new Promise((res, rej) => {
      this.resolveDone = res;
      this.rejectDone = rej;
    });
    for (const row of opts.rows) {
      this.observations.set(row.test_id, {
        test_id: row.test_id,
        session_id: row.session_id,
        sequence_index: row.sequence_index,
        input_kind: row.input_kind,
        timestamps: {},
        events: [],
        llm_called: false,
        bot_spoke: false,
      });
    }
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=AudioServiceOutOfProcess",
      ],
    });
    this.context = await this.browser.newContext({
      permissions: ["microphone"],
    });
    this.page = await this.context.newPage();
    this.page.on("console", (m) => {
      // Surface worker-side logs to server stdout for debugging.
      if (m.type() === "error" || m.type() === "warning") {
        // eslint-disable-next-line no-console
        console.log(`[worker:${this.sessionId}] ${m.type()}: ${m.text()}`);
      }
    });
    this.page.on("pageerror", (e) => {
      // eslint-disable-next-line no-console
      console.error(`[worker:${this.sessionId}] pageerror:`, e.message);
    });

    const wsUrl = new URL(this.opts.orchestratorWsUrl);
    wsUrl.searchParams.set("session", this.sessionId);
    wsUrl.searchParams.set("run", this.opts.runId);

    const pageUrl = new URL(this.opts.workerPageUrl);
    pageUrl.searchParams.set("session", this.sessionId);
    pageUrl.searchParams.set("run", this.opts.runId);
    pageUrl.searchParams.set("ws", wsUrl.toString());
    await this.page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded" });
  }

  attachWs(ws: WebSocket): void {
    this.workerWs = ws;
    const startMsg: WsOrchestratorToWorker = {
      type: "start_session",
      session_id: this.sessionId,
      config: this.opts.config,
      rows: this.opts.rows,
      voice_wav_urls: this.opts.voiceWavUrls,
    };
    ws.send(JSON.stringify(startMsg));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsWorkerToOrchestrator;
        this.handleWorkerMessage(msg);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[orch] bad worker msg", e);
      }
    });
    ws.on("close", () => {
      if (!this.finished) {
        // Worker dropped before signalling end-of-session — treat as completion.
        this.completeSuccessfully();
      }
    });
    ws.on("error", (err) => {
      if (!this.finished) {
        this.finished = true;
        this.rejectDone(err);
      }
    });
  }

  private handleWorkerMessage(msg: WsWorkerToOrchestrator): void {
    this.opts.onMessage(msg);
    if (msg.type === "row_event") {
      const obs = this.observations.get(msg.test_id);
      if (obs) {
        obs.events.push(msg.event);
        applyEventToObservation(obs, msg.event);
      }
    } else if (msg.type === "row_dispatched") {
      const obs = this.observations.get(msg.test_id);
      if (obs) obs.timestamps.t_input_start = msg.t;
    } else if (msg.type === "row_complete") {
      const obs = this.observations.get(msg.test_id);
      if (obs) {
        if (msg.bot_transcript) obs.bot_transcript = msg.bot_transcript;
        if (msg.user_transcript) obs.user_transcript = msg.user_transcript;
      }
    } else if (msg.type === "bot_ready") {
      // Record wall-clock anchor once so perf.now() timestamps can be converted to epoch-ms.
      if (!this.wallClockAnchor) {
        this.wallClockAnchor = { wallMs: Date.now(), perfNow: msg.ts };
      }
    } else if (msg.type === "backend_ids") {
      // Stamp every observation with the session-scoped backend identifiers. turn_id is
      // populated later, per-row, from each turn-trace event.
      for (const obs of this.observations.values()) {
        obs.backend = {
          ...(obs.backend ?? {}),
          session_id: msg.backend.session_id,
          character_session_id: msg.backend.character_session_id,
          character_id: msg.backend.character_id,
        };
      }
    } else if (msg.type === "session_ended") {
      this.completeSuccessfully();
    } else if (msg.type === "worker_error") {
      if (!this.finished) {
        this.finished = true;
        this.rejectDone(new Error(msg.message));
      }
    }
  }

  private completeSuccessfully(): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveDone();
  }

  async waitForCompletion(timeoutMs: number): Promise<void> {
    return Promise.race([
      this.donePromise,
      new Promise<void>((_res, rej) =>
        setTimeout(() => rej(new Error(`session ${this.sessionId} timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  async shutdown(): Promise<void> {
    try {
      this.workerWs?.close();
    } catch {
      // ignore
    }
    try {
      await this.page?.close({ runBeforeUnload: false });
    } catch {
      // ignore
    }
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
  }

  /**
   * Cancel an in-flight session. Sends stop_session to the worker so it can disconnect
   * cleanly from LiveKit (~500ms grace), then forces Playwright teardown. Idempotent.
   */
  async cancel(): Promise<void> {
    if (this.finished) return;
    try {
      if (this.workerWs && this.workerWs.readyState === this.workerWs.OPEN) {
        this.workerWs.send(JSON.stringify({ type: "stop_session" }));
      }
    } catch {
      // ignore
    }
    await Promise.race([
      new Promise((res) => setTimeout(res, 500)),
      this.donePromise.catch(() => undefined),
    ]);
    await this.shutdown();
    this.completeSuccessfully();
  }
}

// Encodes the orchestrator's interpretation of SDK event names into the observation booleans
// and timestamp slots. Keep aligned with worker/src/SdkBridge.ts emitted event names.
function applyEventToObservation(obs: RowObservation, ev: CapturedEvent): void {
  switch (ev.name) {
    case "botRespondingChange:true":
      obs.timestamps.t_responding_start ??= ev.ts;
      obs.llm_called = true;
      break;
    case "botRespondingChange:false":
      obs.timestamps.t_responding_end ??= ev.ts;
      break;
    case "botOutput":
      obs.timestamps.t_first_bot_output ??= ev.ts;
      // The public SDK 1.3.x does not emit botRespondingChange; any of botOutput,
      // botTtsStarted, or speakingChange:true is unambiguous evidence that the
      // server invoked the LLM for this turn.
      obs.llm_called = true;
      break;
    case "botTtsStarted":
      obs.timestamps.t_tts_started ??= ev.ts;
      obs.llm_called = true;
      break;
    case "speakingChange:true":
      obs.timestamps.t_speaking_start ??= ev.ts;
      obs.bot_spoke = true;
      obs.llm_called = true;
      break;
    case "speakingChange:false":
      obs.timestamps.t_speaking_end ??= ev.ts;
      break;
    case "turnEnd":
      obs.timestamps.t_turn_end ??= ev.ts;
      break;
    case "llmNoResponse":
      // LLM was called but declined to respond (abstain).
      obs.llm_called = true;
      break;
    case "input_end":
      // Synthetic event emitted by worker when audio playback (Voice In) finishes,
      // or when updateContext() returns (Dynamic Context).
      obs.timestamps.t_input_end ??= ev.ts;
      break;
    case "turn_trace": {
      // Synthetic event carrying the server-emitted per-turn timeline. Routed by SdkBridge
      // to the response queue head (or the most-recently-popped owner).
      const trace = ev.data as TurnTrace | undefined;
      if (trace) {
        obs.turn_trace = trace;
        if (trace.turn_id) {
          obs.backend = { ...(obs.backend ?? {}), turn_id: trace.turn_id };
        }
        if (trace.was_canceled !== undefined) obs.was_canceled = trace.was_canceled;
      }
      break;
    }
    case "dispatched_mid_turn":
      // Synthetic event emitted by the scheduler when a Dynamic Context row fires while
      // a previous bot turn is still being processed. Lets the classifier distinguish
      // "server collapsed this by design" from "server has a real bug".
      obs.dispatched_mid_turn = true;
      break;
  }
}
