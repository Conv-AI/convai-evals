import { ConvaiClient } from "@convai/web-sdk";
import { getLipSyncValuesFromOrder61 } from "@convai/web-sdk/lipsync-helpers";
import type { EndpointKey } from "@convai/evals-shared";
import type { LipSyncValues, VisualTurnStats } from "./visualTypes.js";

export interface VisualSessionConfig {
  endpoint: EndpointKey;
  endpointUrl: string;
  apiKey: string;
  characterId: string;
}

export interface VisualSessionSink {
  onSpeakingChange?(speaking: boolean, atMs: number): void;
  onBlendshapeFrame?(values: LipSyncValues, atMs: number): void;
  onBlendshapeFrames?(values: LipSyncValues[], atMs: number): void;
  onBlendshapeChunk?(frameCount: number, atMs: number): void;
  onBlendshapeStats?(stats: VisualTurnStats | undefined, atMs: number): void;
  onTurnEnd?(atMs: number): void;
  onResponseText?(text: string, streaming: boolean, atMs: number): void;
  onNoResponse?(atMs: number): void;
  onLog?(name: string, atMs: number, data?: Record<string, unknown>): void;
}

export class ConvaiVisualSession {
  private client: any;
  private sink: VisualSessionSink | null = null;
  private offFns: Array<() => void> = [];
  private botReady = false;
  private readyWaiters: Array<() => void> = [];

  constructor(private config: VisualSessionConfig) {}

  async connect(): Promise<any> {
    this.client = new ConvaiClient({
      apiKey: this.config.apiKey,
      characterId: this.config.characterId,
      endUserId: `visual-lipsync-${Date.now()}`,
      enableVideo: false,
      startWithAudioOn: false,
      ttsEnabled: true,
      enableLipsync: true,
      blendshapeConfig: { format: "arkit" },
      url: normalizeUrl(this.config.endpointUrl),
      debug: true,
    });

    this.on("botReady", () => {
      this.sink?.onLog?.("bot_ready", performance.now());
      this.botReady = true;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const resolve of waiters) resolve();
    });
    this.on("speakingChange", (speaking: boolean) => {
      const atMs = performance.now();
      this.sink?.onLog?.("speaking_change", atMs, { speaking });
      this.sink?.onSpeakingChange?.(speaking, atMs);
    });
    this.on("blendshapes", (data: unknown) => {
      const frames = extractBlendshapeFrames(data);
      if (frames.length === 0) return;
      const atMs = performance.now();
      this.sink?.onLog?.("blendshape_chunk", atMs, { frameCount: frames.length });
      this.sink?.onBlendshapeChunk?.(frames.length, atMs);
      const values = frames.map((frame) => getLipSyncValuesFromOrder61(frame));
      this.sink?.onBlendshapeFrames?.(values, atMs);
      for (const value of values) {
        this.sink?.onBlendshapeFrame?.(value, atMs);
      }
    });
    this.on("blendshapeStatsReceived", (data: unknown) => {
      const atMs = performance.now();
      const stats = extractStats(data);
      this.sink?.onLog?.("blendshape_stats", atMs, { stats });
      this.sink?.onBlendshapeStats?.(stats, atMs);
    });
    this.on("turnEnd", () => {
      const atMs = performance.now();
      this.sink?.onLog?.("turn_end", atMs);
      this.sink?.onTurnEnd?.(atMs);
    });
    this.on("llmNoResponse", () => {
      const atMs = performance.now();
      this.sink?.onLog?.("llm_no_response", atMs);
      this.sink?.onNoResponse?.(atMs);
    });
    this.on("messagesChange", (messages: unknown) => {
      const latest = latestBotMessage(messages);
      if (latest) {
        const atMs = performance.now();
        this.sink?.onLog?.("response_text", atMs, {
          chars: latest.content.length,
          streaming: Boolean(latest.isStreaming),
        });
        this.sink?.onResponseText?.(latest.content, Boolean(latest.isStreaming), atMs);
      }
    });

    await this.client.connect();
    try {
      await this.client.audioControls?.disableAudio?.();
      this.sink?.onLog?.("microphone_disabled", performance.now());
    } catch (e) {
      this.sink?.onLog?.("microphone_disable_error", performance.now(), {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return this.client;
  }

  setSink(sink: VisualSessionSink | null): void {
    this.sink = sink;
  }

  async waitForBotReady(timeoutMs = 45000): Promise<void> {
    if (this.botReady || this.client?.isBotReady) return;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(
          new Error(
            "botReady timeout. Check the character ID, API key, endpoint, and whether the character has lipsync enabled.",
          ),
        );
      }, timeoutMs);
      this.readyWaiters.push(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }

  sendText(text: string): void {
    if (!this.client) throw new Error("Convai session is not connected");
    if (typeof this.client.sendUserTextMessage === "function") {
      this.client.sendUserTextMessage(text);
      return;
    }
    if (typeof this.client.sendText === "function") {
      this.client.sendText(text);
      return;
    }
    throw new Error("sendUserTextMessage is not available on the Convai client");
  }

  getRoom(): any {
    return this.client?.room;
  }

  async disconnect(): Promise<void> {
    this.setSink(null);
    for (const off of this.offFns.splice(0)) off();
    await this.client?.disconnect?.();
  }

  private on(name: string, handler: (...args: any[]) => void): void {
    this.client.on(name, handler);
    this.offFns.push(() => this.client?.off?.(name, handler));
  }
}

function extractBlendshapeFrames(data: unknown): number[][] {
  const maybe = data as { blendshapes?: unknown } | undefined;
  if (!Array.isArray(maybe?.blendshapes)) return [];
  return maybe.blendshapes.filter(
    (frame): frame is number[] => Array.isArray(frame) && frame.every((v) => typeof v === "number"),
  );
}

function extractStats(data: unknown): VisualTurnStats | undefined {
  const stats = (data as { stats?: VisualTurnStats } | undefined)?.stats;
  if (stats && typeof stats === "object") return stats;
  return undefined;
}

function latestBotMessage(messages: unknown): { content: string; isStreaming?: boolean } | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { type?: string; content?: unknown; isStreaming?: boolean };
    if (msg?.type === "bot-llm-text" && typeof msg.content === "string") {
      return { content: msg.content, isStreaming: msg.isStreaming };
    }
  }
  return null;
}

function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}
