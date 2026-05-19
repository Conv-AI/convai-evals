import type { CapturedEvent, RunConfig, TestRow } from "@convai/evals-shared";
import type { MicSink } from "./MicSink.js";
import type { SdkBridge } from "./SdkBridge.js";
import type { EventStream } from "./EventStream.js";

interface SchedulerDeps {
  rows: TestRow[];
  voiceWavUrls: Record<string, string>;
  config: RunConfig;
  mic: MicSink;
  sdk: SdkBridge;
  events: EventStream;
  sessionId: string;
}

export class Scheduler {
  // Track per-row turn-end so we can mark row_complete when the bot finishes speaking.
  private rowDone = new Map<string, () => void>();
  private buffers = new Map<string, AudioBuffer>();
  private aborted = false;

  constructor(private deps: SchedulerDeps) {}

  /** Signals all in-flight row waits to resolve immediately and prevents new dispatches. */
  abort(): void {
    this.aborted = true;
    const waiters = Array.from(this.rowDone.values());
    this.rowDone.clear();
    for (const resolve of waiters) resolve();
  }

  async preloadVoiceBuffers(): Promise<void> {
    const entries = Object.entries(this.deps.voiceWavUrls);
    await Promise.all(
      entries.map(async ([testId, url]) => {
        try {
          const buf = await this.deps.mic.decodeWavFromUrl(url);
          this.buffers.set(testId, buf);
        } catch (e) {
          console.error(`[scheduler] failed to load WAV for ${testId}:`, e);
        }
      }),
    );
  }

  async run(): Promise<void> {
    const rows = [...this.deps.rows].sort((a, b) => a.sequence_index - b.sequence_index);
    if (rows.length === 0) return;
    const firstOffset = rows[0]!.timestamp_offset_s;
    const speed = Math.max(0.01, this.deps.config.speedMultiplier);
    const sessionStart = performance.now();

    // Bot events route via SdkBridge's response queue. We resolve a row's turn-end wait
    // when one of these end-of-turn events lands on it.
    this.deps.sdk.setEventSink((testId, ev) => {
      this.deps.events.send({
        type: "row_event",
        session_id: this.deps.sessionId,
        test_id: testId,
        event: ev,
      });
      if (
        ev.name === "turnEnd" ||
        ev.name === "speakingChange:false" ||
        ev.name === "llmNoResponse"
      ) {
        const resolve = this.rowDone.get(testId);
        if (resolve) resolve();
      }
    });

    const dispatches = rows.map((row) => this.scheduleRow(row, firstOffset, speed, sessionStart));
    await Promise.allSettled(dispatches);

    this.deps.events.send({ type: "session_ended", session_id: this.deps.sessionId });
  }

  private async scheduleRow(
    row: TestRow,
    firstOffset: number,
    speed: number,
    sessionStart: number,
  ): Promise<void> {
    const target = sessionStart + ((row.timestamp_offset_s - firstOffset) * 1000) / speed;
    const now = performance.now();
    const delay = Math.max(0, target - now);
    await sleep(delay);
    if (this.aborted) return;

    this.deps.sdk.initTranscripts(row.test_id);
    const t = performance.now();
    this.deps.events.send({
      type: "row_dispatched",
      session_id: this.deps.sessionId,
      test_id: row.test_id,
      sequence_index: row.sequence_index,
      t,
    });

    const payload = safeParsePayload(row.rtvi_payload_json);
    const data = payload?.data ?? {};
    const expectsResponse =
      row.input_kind === "Voice In" ||
      row.input_kind === "Text In" ||
      (row.input_kind === "Dynamic Context" && data.run_llm !== "false");

    // Flag Dynamic Context rows that fire while a previous bot turn is still in flight.
    // The failure classifier uses this to distinguish "server dropped this update by design"
    // from an actual behavior mismatch. Captured BEFORE enqueueing this row so the count
    // reflects prior in-flight turns, not this one.
    if (row.input_kind === "Dynamic Context" && (data.run_llm === "auto" || data.run_llm === undefined)) {
      const pendingCount = this.deps.sdk.getPendingResponseCount();
      if (pendingCount > 0) {
        this.deps.events.send({
          type: "row_event",
          session_id: this.deps.sessionId,
          test_id: row.test_id,
          event: { name: "dispatched_mid_turn", ts: t, data: { pending_count: pendingCount } },
        });
      }
    }

    if (expectsResponse) this.deps.sdk.enqueueResponse(row.test_id);

    let inputEndTs = t;
    try {
      if (row.input_kind === "Voice In") {
        // This Voice In becomes the current user-input owner for STT attribution.
        // userInputOwner stays pointing at it until the next Voice In row dispatches.
        this.deps.sdk.setUserInputOwner(row.test_id);
        const buffer = this.buffers.get(row.test_id);
        if (buffer) {
          await this.deps.mic.play(buffer);
          inputEndTs = performance.now();
        } else {
          const text = data.text ?? row.input_text ?? "";
          if (text) this.deps.sdk.sendUserText(text);
          inputEndTs = performance.now();
        }
      } else if (row.input_kind === "Text In") {
        // Send text directly — no TTS, no mic, no STT attribution.
        const text = data.text ?? row.input_text ?? "";
        if (text) this.deps.sdk.sendUserText(text);
        inputEndTs = performance.now();
      } else {
        this.deps.sdk.updateContext({
          text: data.text,
          mode: data.mode,
          run_llm: data.run_llm,
          current_attention_object: data.current_attention_object,
        });
        inputEndTs = performance.now();
      }
    } catch (e) {
      console.error("[scheduler] dispatch failed for", row.test_id, e);
    }

    // Synthetic event so the orchestrator can stamp t_input_end. We address this directly
    // to the row's own test_id (bypassing the queue) since it's about the input, not the bot.
    const inputEndEvent: CapturedEvent = { name: "input_end", ts: inputEndTs };
    this.deps.events.send({
      type: "row_event",
      session_id: this.deps.sessionId,
      test_id: row.test_id,
      event: inputEndEvent,
    });

    const timeoutMs = expectsResponse ? 8000 : 1500;
    await this.waitForTurnEndOrTimeout(row.test_id, timeoutMs);

    // Whether the wait resolved via a turn-end event or by timeout, ensure the row
    // is no longer in the response queue so subsequent rows can advance.
    this.deps.sdk.cancelPendingResponse(row.test_id);

    const { bot, user } = this.deps.sdk.getTranscriptsFor(row.test_id);
    this.deps.events.send({
      type: "row_complete",
      session_id: this.deps.sessionId,
      test_id: row.test_id,
      bot_transcript: bot || undefined,
      user_transcript: user || undefined,
    });
  }

  private waitForTurnEndOrTimeout(testId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.rowDone.delete(testId);
        resolve();
      };
      this.rowDone.set(testId, finish);
      setTimeout(finish, timeoutMs);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeParsePayload(raw: string): { type?: string; data?: any } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
