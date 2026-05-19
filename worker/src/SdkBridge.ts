import type { CapturedEvent, ContextMode, RowCorrelation, RunConfig, RunLlm, TurnTrace } from "@convai/evals-shared";
import { installTurnTraceTap } from "./turnTracePatch.js";
import { getCapturedConnectInfo } from "./connectIntercept.js";

// SDK event names captured. Stays in sync with server/orchestrator/WorkerHandle.applyEventToObservation.
const EVENT_NAMES_RAW: readonly string[] = [
  "botReady",
  "userTranscriptionChange",
  "blendshapes",
  "blendshapeStatsReceived",
  "metrics",
  "emotionChange",
  "idleWarning",
  "llmNoResponse",
  "turnEnd",
  "conversationStart",
  "messagesChange",
];
const EVENT_NAMES_BOOL: readonly string[] = [
  "botRespondingChange",
  "speakingChange",
  "listeningChange",
];

// Events emitted from the user input side (mic / STT).
const USER_INPUT_EVENTS = new Set<string>([
  "userTranscriptionChange",
  "listeningChange:true",
  "listeningChange:false",
]);

// Events emitted from the bot side (LLM / TTS / audio). These route to whichever
// row's response is currently in flight (the head of pendingResponses).
const BOT_EVENTS = new Set<string>([
  "emotionChange",
  "llmNoResponse",
  "turnEnd",
  "botRespondingChange:true",
  "botRespondingChange:false",
  "speakingChange:true",
  "speakingChange:false",
  "blendshapes",
  "blendshapeStatsReceived",
]);

// Events that signal the current bot turn is finished. Triggers popping the
// queue head so the next row's response can start being attributed.
const BOT_TURN_END_EVENTS = new Set<string>([
  "speakingChange:false",
  "turnEnd",
  "llmNoResponse",
  "botRespondingChange:false",
]);

export interface ParsedRtviPayload {
  type: "user_text_message" | "context-update";
  data: {
    text?: string;
    mode?: ContextMode;
    run_llm?: RunLlm;
    current_attention_object?: string;
  };
}

interface TranscriptBuckets {
  bot: string;
  user: string;
}

/**
 * Event routing model:
 *
 *   - userInputOwner: a single pointer to the test_id whose Voice In is the
 *     "current user utterance". Set when a Voice In row dispatches; stays
 *     pointing at that row until the next Voice In row dispatches. STT/mic
 *     events route here.
 *
 *   - pendingResponses: a FIFO queue of test_ids that triggered an LLM call
 *     and are waiting for the bot's reply. Bot-side events route to the head.
 *     When the head's turn ends (speakingChange:false / turnEnd / llmNoResponse),
 *     the head is popped so the next pending row can start receiving events.
 *
 * This matches real gameplay: a Voice In's reply belongs to that Voice In,
 * regardless of how many context-updates fire in the meantime.
 */
export class SdkBridge {
  client: any;
  private listeners: Array<() => void> = [];
  private userInputOwner: string | null = null;
  private pendingResponses: string[] = [];
  private currentOutboundCorrelation: RowCorrelation | null = null;
  private botMessageOwners = new Map<string, string>();
  // 1-deep ring of the most recently popped response owner. Lets a turn-trace that arrives
  // just after speakingChange:false still land on the right row.
  private lastBotTurnOwner: string | null = null;
  private transcripts = new Map<string, TranscriptBuckets>();
  private onEvent: (testId: string, ev: CapturedEvent) => void = () => {};
  private botReadyFired = false;
  private botReadyWaiters: Array<() => void> = [];

  constructor(private config: RunConfig, private sessionId: string, private runId: string) {}

  async connect(): Promise<void> {
    const mod: any = await import("@convai/web-sdk");
    const ConvaiClient = mod.ConvaiClient ?? mod.default?.ConvaiClient ?? mod.default;
    if (!ConvaiClient) throw new Error("ConvaiClient export not found in @convai/web-sdk");

    this.client = new ConvaiClient({
      apiKey: this.config.apiKey,
      characterId: this.config.characterId,
      endUserId: this.sessionId,
      enableVideo: false,
      startWithAudioOn: true,
      ttsEnabled: true,
      // Tells the server to enable the blendshape pipeline so the client
      // receives lipsync animation frames alongside the TTS audio. Without this,
      // blendshape_provider defaults to "none" and no animation data is sent.
      enableLipsync: true,
      url: normalizeUrl(this.config.endpointUrl),
      // Enables core-service to emit per-turn `turn-trace` RTVI messages with the full
      // timeline + critical-stage attribution. Required for server-side e2e capture.
      debug: true,
    });

    // Wire the botReady listener BEFORE client.connect() so we don't miss the
    // event if the SDK fires it synchronously from inside connect().
    const onBotReady = () => {
      this.botReadyFired = true;
      const waiters = this.botReadyWaiters;
      this.botReadyWaiters = [];
      for (const w of waiters) w();
    };
    this.client.on("botReady", onBotReady);
    this.listeners.push(() => this.client.off?.("botReady", onBotReady));

    for (const name of EVENT_NAMES_RAW) {
      const handler = (data: unknown) => this.emit(name, data);
      this.client.on(name, handler);
      this.listeners.push(() => this.client.off?.(name, handler));
    }
    for (const name of EVENT_NAMES_BOOL) {
      const handler = (value: boolean) => this.emit(`${name}:${value}`, value);
      this.client.on(name, handler);
      this.listeners.push(() => this.client.off?.(name, handler));
    }

    await this.client.connect();
    this.installPublishDataCorrelation();

    // Install the turn-trace tap after connect so client.room is fully wired.
    try {
      const off = installTurnTraceTap(this.client, (trace) => this.handleTurnTrace(trace));
      this.listeners.push(off);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[sdk-bridge] turn-trace tap install failed:", e);
    }
  }

  /** Backend identifiers, sourced from the captured /connect response body (preferred)
   * with sensible fallbacks. The server's session_id is the real per-session identifier
   * for diagnostics; client.room.name is only a LiveKit room name and is used as a
   * last-resort fallback. character_session_id is the per-connection interaction id. */
  getBackendIds(): {
    session_id?: string;
    character_session_id?: string;
    character_id: string;
  } {
    const info = getCapturedConnectInfo();
    const sdkCharacterSession: string | undefined = this.client?.characterSessionId;
    return {
      session_id: info.session_id ?? this.client?.room?.name ?? undefined,
      character_session_id: info.character_session_id ?? sdkCharacterSession,
      character_id: this.config.characterId,
    };
  }

  /** Route the trace to the row whose response queue head matches, or fall back to the
   * most-recently-popped owner if the queue is empty. The server's `turn_id` is opaque to us. */
  private handleTurnTrace(trace: TurnTrace): void {
    const testId = this.pendingResponses[0] ?? this.lastBotTurnOwner;
    if (!testId) return;
    this.onEvent(testId, { name: "turn_trace", ts: performance.now(), data: trace });
  }

  setEventSink(handler: (testId: string, ev: CapturedEvent) => void): void {
    this.onEvent = handler;
  }

  // -------- Routing API --------

  setUserInputOwner(testId: string | null): void {
    this.userInputOwner = testId;
  }

  enqueueResponse(testId: string): void {
    this.pendingResponses.push(testId);
    this.initTranscripts(testId);
  }

  /** Snapshot of in-flight bot-response queue depth. Used by the scheduler to flag
   * Dynamic Context rows that dispatch while a previous turn is still being processed. */
  getPendingResponseCount(): number {
    return this.pendingResponses.length;
  }

  getPendingResponseIds(): string[] {
    return [...this.pendingResponses];
  }

  interruptPendingResponses(): string[] {
    const interrupted = [...this.pendingResponses];
    this.pendingResponses = [];
    if (interrupted.length > 0) {
      this.lastBotTurnOwner = interrupted[interrupted.length - 1] ?? null;
    }
    return interrupted;
  }

  /** Idempotent: removes testId from the queue if still present (used on row timeout). */
  cancelPendingResponse(testId: string): void {
    this.pendingResponses = this.pendingResponses.filter((t) => t !== testId);
  }

  initTranscripts(testId: string): void {
    if (!this.transcripts.has(testId)) {
      this.transcripts.set(testId, { bot: "", user: "" });
    }
  }

  getTranscriptsFor(testId: string): TranscriptBuckets {
    return this.transcripts.get(testId) ?? { bot: "", user: "" };
  }

  // -------- SDK calls --------

  async waitForBotReady(timeoutMs = 45000): Promise<void> {
    if (this.botReadyFired) return;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `botReady timeout after ${timeoutMs}ms — the Convai backend never signaled ready. ` +
              "Common causes: bad character ID or API key, the endpoint URL doesn't match the key's environment, " +
              "the character is misconfigured (e.g. lipsync provider unavailable), or LiveKit/WebRTC is blocked.",
          ),
        );
      }, timeoutMs);
      this.botReadyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  sendUserText(text: string, correlation?: RowCorrelation): void {
    this.withOutboundCorrelation(correlation, () => {
      if (typeof this.client.sendUserTextMessage === "function") {
        this.client.sendUserTextMessage(text);
      } else if (typeof this.client.sendText === "function") {
        this.client.sendText(text);
      } else {
        throw new Error("sendUserTextMessage not found on client");
      }
    });
  }

  /**
   * Send a context-update via the SDK's updateContext API.
   * The optional `current_attention_object` field is forward-compatible with SDK versions
   * that expose attention-object context updates. Older SDK versions silently drop unknown
   * option keys.
   */
  updateContext(opts: {
    text?: string;
    mode?: ContextMode;
    run_llm?: RunLlm;
    current_attention_object?: string;
  }, correlation?: RowCorrelation): void {
    const fn = this.client.updateContext ?? this.client.updateDynamicInfo;
    if (typeof fn !== "function") throw new Error("updateContext not found on client");
    this.withOutboundCorrelation(correlation, () => fn.call(this.client, opts as unknown));
  }

  async disconnect(): Promise<void> {
    for (const off of this.listeners) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.listeners.length = 0;
    try {
      await this.client?.disconnect?.();
    } catch {
      // ignore
    }
  }

  // -------- Event routing --------

  private emit(name: string, data: unknown): void {
    let testId: string | null = null;

    if (USER_INPUT_EVENTS.has(name)) {
      testId = this.userInputOwner;
    } else if (BOT_EVENTS.has(name)) {
      testId = this.pendingResponses[0] ?? null;
      // Pop the queue head exactly once per bot-turn-end event, and only if it still
      // matches the testId we just routed to (defensive against re-entrant events).
      if (BOT_TURN_END_EVENTS.has(name) && testId && this.pendingResponses[0] === testId) {
        this.pendingResponses.shift();
        this.lastBotTurnOwner = testId;
      }
    } else if (name === "messagesChange") {
      // SDK 1.3.x emits messagesChange with the full ChatMessage[] (see
      // node_modules/@convai/web-sdk/dist/core/MessageHandler.js:137,162,177 etc).
      // Mine the latest bot-llm-text and user-transcription contents — `content` is
      // mutated in place by the SDK as the message streams, so each emission already
      // holds the cumulative text. Overwrite (don't append) to avoid duplication.
      const messages: ChatMessage[] = Array.isArray(data) ? (data as ChatMessage[]) : [];
      const lastBot = findLast(messages, (m) => m.type === "bot-llm-text");
      const lastUser = findLast(messages, (m) => m.type === "user-transcription");
      const botOwner = lastBot ? this.ownerForBotMessage(lastBot) : undefined;
      if (lastBot && botOwner) {
        const t = this.transcripts.get(botOwner);
        if (t) t.bot = lastBot.content;
      }
      if (lastUser && this.userInputOwner) {
        const t = this.transcripts.get(this.userInputOwner);
        if (t) t.user = lastUser.content;
      }
      // Still record the event itself for the per-row events array; route to the most
      // contextually current testId.
      testId = this.pendingResponses[0] ?? this.userInputOwner;
    } else {
      // Session-level (botReady, metrics, conversationStart, idleWarning). Attribute to
      // whichever row is most contextually current.
      testId = this.pendingResponses[0] ?? this.userInputOwner;
    }

    if (!testId) return;
    this.onEvent(testId, { name, ts: performance.now(), data });
  }

  private ownerForBotMessage(message: ChatMessage): string | undefined {
    const existing = this.botMessageOwners.get(message.id);
    if (existing) return existing;
    const owner = this.pendingResponses[0] ?? this.lastBotTurnOwner ?? undefined;
    if (owner) this.botMessageOwners.set(message.id, owner);
    return owner;
  }

  private withOutboundCorrelation(correlation: RowCorrelation | undefined, fn: () => void): void {
    const previous = this.currentOutboundCorrelation;
    this.currentOutboundCorrelation = correlation ?? null;
    try {
      fn();
    } finally {
      this.currentOutboundCorrelation = previous;
    }
  }

  private installPublishDataCorrelation(): void {
    const participant = this.client?.room?.localParticipant;
    const publishData = participant?.publishData;
    if (!participant || typeof publishData !== "function") return;

    const original = publishData.bind(participant);
    const bridge = this;
    participant.publishData = function patchedPublishData(data: Uint8Array, options?: unknown) {
      const correlation = bridge.currentOutboundCorrelation;
      if (!correlation) return original(data, options);

      const patched = patchOutboundPayload(data, correlation);
      if (patched) {
        correlation.outbound_metadata = {
          injected: true,
          message_type: patched.messageType,
        };
        bridge.onEvent(correlation.row_id, {
          name: "outbound_metadata_injected",
          ts: performance.now(),
          data: { client_event_id: correlation.client_event_id, message_type: patched.messageType },
        });
        return original(patched.data, options);
      }
      return original(data, options);
    };
    this.listeners.push(() => {
      participant.publishData = original;
    });
  }
}

// Mirrors @convai/web-sdk's ChatMessage shape (dist/core/types.d.ts:345). Defined
// locally because the SDK package doesn't re-export it from its public entry.
interface ChatMessage {
  id: string;
  type: string;
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

function findLast<T>(arr: readonly T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== undefined && pred(v)) return v;
  }
  return undefined;
}

function normalizeUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function patchOutboundPayload(
  data: Uint8Array,
  correlation: RowCorrelation,
): { data: Uint8Array; messageType: string } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type !== "user_text_message" && parsed.type !== "context-update") return null;
  parsed.data = {
    ...(parsed.data ?? {}),
    client_event_id: correlation.client_event_id,
    eval_metadata: {
      eval_run_id: correlation.eval_run_id,
      eval_session_id: correlation.eval_session_id,
      row_id: correlation.row_id,
      sequence_index: correlation.sequence_index,
      input_kind: correlation.input_kind,
    },
  };
  return {
    data: new TextEncoder().encode(JSON.stringify(parsed)),
    messageType: parsed.type,
  };
}
