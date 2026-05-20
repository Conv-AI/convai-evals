import type { AudioProbe } from "./AudioProbe.js";
import type { ConvaiVisualSession, VisualSessionSink } from "./ConvaiVisualSession.js";
import type { LowPolyFaceRenderer } from "./LowPolyFaceRenderer.js";
import { computeVisualMetrics } from "./visualMetrics.js";
import type {
  LipSyncValues,
  VisualPrompt,
  VisualSnapshot,
  VisualTimelineSample,
  VisualTurnCapture,
  VisualTurnResult,
  VisualTurnStats,
} from "./visualTypes.js";

export interface TurnRunnerOptions {
  session: ConvaiVisualSession;
  renderer: LowPolyFaceRenderer;
  audioProbe: AudioProbe;
  prompts: VisualPrompt[];
  timeoutMs: number;
  signal?: AbortSignal;
  onTurnStart?: (turnIndex: number, prompt: string) => void;
  onTurnUpdate?: (capture: VisualTurnCapture) => void;
  onTurnComplete?: (result: VisualTurnResult) => void;
}

export class TurnRunner {
  constructor(private opts: TurnRunnerOptions) {}

  async run(): Promise<VisualTurnResult[]> {
    const prompts = this.opts.prompts.slice(0, 20);
    const results: VisualTurnResult[] = [];
    for (let i = 0; i < prompts.length; i++) {
      if (this.opts.signal?.aborted) break;
      const result = await this.runOne(prompts[i]!, i + 1);
      results.push(result);
      if (result.error === "visual lipsync run canceled") break;
    }
    return results;
  }

  private async runOne(prompt: VisualPrompt, turnIndex: number): Promise<VisualTurnResult> {
    if (this.opts.signal?.aborted) throw new Error("visual lipsync run canceled");
    this.opts.renderer.resetMouth();
    this.opts.onTurnStart?.(turnIndex, prompt.text);
    const startedAt = performance.now();
    const capture: VisualTurnCapture = {
      turnIndex,
      prompt: prompt.text,
      responseText: "",
      startedAtIso: new Date().toISOString(),
      durationMs: 0,
      timedOut: false,
      blendshapeFrameCount: 0,
      blendshapeChunkCount: 0,
      playedBlendshapeFrameCount: 0,
      audioDebug: this.opts.audioProbe.getDebug(),
      debugEvents: [],
      samples: [],
      snapshots: [],
    };

    let speaking = false;
    let speakingStarted = false;
    let responseStreaming = true;
    let turnEnded = false;
    let statsReceived = false;
    let noResponse = false;
    let lastActivity = performance.now();
    let lastBlendshape = 0;
    let lastSnapshot = 0;
    let lastAudioScan = 0;
    let lastFramePlay = 0;
    let audioEverActive = false;
    let lastAudioActive = 0;
    let audioQuietStopped = false;
    let lastSpeakingFalse = -Infinity;
    const pendingFrames: LipSyncValues[] = [];
    const snapshotCandidates: VisualSnapshot[] = [];
    const log = (name: string, atMs = performance.now(), data?: Record<string, unknown>) => {
      capture.debugEvents.push({ tMs: atMs - startedAt, name, data });
      if (capture.debugEvents.length > 1200) capture.debugEvents.shift();
    };

    const sink: VisualSessionSink = {
      onLog: (name, atMs, data) => log(name, atMs, data),
      onSpeakingChange: (isSpeaking, atMs) => {
        speaking = isSpeaking;
        speakingStarted ||= isSpeaking;
        if (isSpeaking) {
          capture.speakingStartMs ??= atMs - startedAt;
          lastSpeakingFalse = -Infinity;
        } else {
          capture.speakingEndMs ??= atMs - startedAt;
          lastSpeakingFalse = atMs;
          // Don't clear frames yet — audio may still be draining from the LiveKit buffer.
          // The 400ms grace window in the sampler lets lipsync finish with the audio.
          log("speaking_stopped", atMs, { pendingFrames: pendingFrames.length });
        }
        lastActivity = atMs;
      },
      onBlendshapeChunk: (frameCount, atMs) => {
        capture.blendshapeChunkCount += 1;
        capture.blendshapeFrameCount += frameCount;
        lastBlendshape = atMs;
        const withinGrace = !speaking && lastSpeakingFalse !== -Infinity && atMs - lastSpeakingFalse < 400;
        if (!audioQuietStopped && (speaking || withinGrace)) lastActivity = atMs;
      },
      onBlendshapeFrames: (values, atMs) => {
        const withinGrace = !speaking && lastSpeakingFalse !== -Infinity && atMs - lastSpeakingFalse < 400;
        if (!audioQuietStopped && (speaking || withinGrace)) pendingFrames.push(...values);
        lastBlendshape = atMs;
      },
      onBlendshapeFrame: (values: LipSyncValues, atMs) => {
        if (!speaking && pendingFrames.length === 0) this.opts.renderer.setLipValues(values);
        lastBlendshape = atMs;
      },
      onBlendshapeStats: (stats: VisualTurnStats | undefined, atMs) => {
        capture.turnStats = stats;
        capture.statsReceivedMs = atMs - startedAt;
        statsReceived = true;
        lastActivity = atMs;
      },
      onTurnEnd: (atMs) => {
        turnEnded = true;
        capture.turnEndMs = atMs - startedAt;
        lastActivity = atMs;
      },
      onNoResponse: (atMs) => {
        noResponse = true;
        turnEnded = true;
        capture.turnEndMs = atMs - startedAt;
        lastActivity = atMs;
      },
      onResponseText: (text, streaming, atMs) => {
        capture.responseText = text;
        responseStreaming = streaming;
        lastActivity = atMs;
      },
    };

    this.opts.session.setSink(sink);
    this.opts.audioProbe.setLogHandler((name, data) => log(name, performance.now(), data));
    await this.opts.audioProbe.resume();
    log("send_text", performance.now(), { prompt: prompt.text });
    this.opts.session.sendText(prompt.text);

    let sampler: number | null = window.setInterval(() => {
      const now = performance.now();
      const tMs = now - startedAt;
      if (now - lastAudioScan > 500) {
        this.opts.audioProbe.scanExistingTracks();
        lastAudioScan = now;
      }
      const audioLevel = this.opts.audioProbe.getLevel();
      if (audioLevel > 0.008) {
        audioEverActive = true;
        lastAudioActive = now;
        audioQuietStopped = false;
      }
      const audioQuietFor = audioEverActive ? now - lastAudioActive : 0;
      // 600ms threshold avoids triggering during natural inter-sentence pauses (~300ms).
      const shouldStopForQuietAudio =
        speaking && audioEverActive && audioQuietFor >= 600 && (pendingFrames.length > 0 || this.opts.renderer.getMouthSignal() > 0.025);
      if (shouldStopForQuietAudio && !audioQuietStopped) {
        const dropped = clearPendingLipsyncFrames(pendingFrames);
        this.opts.renderer.resetMouth();
        audioQuietStopped = true;
        log("lipsync_stopped_on_audio_quiet", now, {
          droppedPendingFrames: dropped,
          audioQuietForMs: Math.round(audioQuietFor),
          audioLevel,
        });
      }
      // Allow consuming frames for 400ms after speakingChange:false so the LiveKit audio
      // buffer drains in sync with lipsync, then clean up whatever remains.
      const withinSpeakingGrace = !speaking && lastSpeakingFalse !== -Infinity && now - lastSpeakingFalse < 400;
      const frameInterval = capture.turnStats?.fps ? 1000 / capture.turnStats.fps : 1000 / 60;
      if (
        shouldConsumeLipsyncFrame({
          speaking: (speaking || withinSpeakingGrace) && !audioQuietStopped,
          pendingFrames: pendingFrames.length,
          elapsedSinceLastFrameMs: now - lastFramePlay,
          frameIntervalMs: frameInterval,
        })
      ) {
        const next = pendingFrames.shift();
        if (next) {
          this.opts.renderer.setLipValues(next);
          capture.playedBlendshapeFrameCount += 1;
          lastFramePlay = now;
        }
      }
      if (!speaking && lastSpeakingFalse !== -Infinity && now - lastSpeakingFalse >= 400 && pendingFrames.length > 0) {
        const dropped = clearPendingLipsyncFrames(pendingFrames);
        this.opts.renderer.resetMouth();
        lastSpeakingFalse = -Infinity;
        log("lipsync_stopped_grace_expired", now, { droppedPendingFrames: dropped });
      }
      if (speakingStarted && !speaking && pendingFrames.length === 0) {
        this.opts.renderer.resetMouth();
      }
      const sample = this.opts.renderer.makeSample(tMs, audioLevel);
      capture.samples.push(sample);
      capture.audioDebug = this.opts.audioProbe.getDebug();
      if (audioLevel > 0.018 || (speaking && (sample.visualMouth > 0.025 || sample.pixelMouth > 0.025))) {
        lastActivity = now;
      }
      if (now - lastSnapshot > 220 && (audioLevel > 0.012 || sample.visualMouth > 0.015 || speaking)) {
        snapshotCandidates.push(this.opts.renderer.captureSnapshot("sample", tMs, audioLevel));
        if (snapshotCandidates.length > 80) snapshotCandidates.shift();
        lastSnapshot = now;
      }
      capture.durationMs = tMs;
      this.opts.onTurnUpdate?.({ ...capture, samples: capture.samples.slice(-220) });
    }, 66);

    try {
      const deadline = startedAt + this.opts.timeoutMs;
      while (performance.now() < deadline) {
        if (this.opts.signal?.aborted) {
          capture.error = "visual lipsync run canceled";
          log("run_canceled");
          break;
        }
        const now = performance.now();
        const quietFor = now - lastActivity;
        const blendshapeDrained =
          audioQuietStopped ||
          (statsReceived && pendingFrames.length === 0) ||
          (capture.blendshapeFrameCount > 0 && pendingFrames.length === 0 && now - lastBlendshape > 800) ||
          (turnEnded && pendingFrames.length === 0 && now - lastBlendshape > 800);
        // turnEnded is a reliable server signal that the turn is over; don't require speakingChange:false
        // because the SDK can re-fire speakingChange:true mid-turn (e.g. between sentences), leaving
        // speaking=true even after the server has finished the response.
        const speechComplete = noResponse || turnEnded || (speakingStarted && !speaking && capture.speakingEndMs !== undefined);
        const textComplete =
          noResponse ||
          turnEnded ||
          !responseStreaming ||
          (capture.responseText.length > 0 && capture.speakingEndMs !== undefined);
        if ((speechComplete || noResponse) && blendshapeDrained && textComplete && quietFor >= 500) {
          log("completion_gate_passed", now, {
            speechComplete,
            blendshapeDrained,
            textComplete,
            quietFor,
            pendingFrames: pendingFrames.length,
          });
          break;
        }
        await wait(80);
      }
      capture.timedOut = performance.now() >= deadline;
      if (capture.timedOut) {
        log("turn_timeout", performance.now(), {
          speaking,
          speakingStarted,
          responseStreaming,
          turnEnded,
          statsReceived,
          pendingFrames: pendingFrames.length,
          audioDebug: capture.audioDebug,
        });
      }
    } catch (e) {
      capture.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      if (sampler !== null) {
        window.clearInterval(sampler);
        sampler = null;
      }
      capture.durationMs = performance.now() - startedAt;
      capture.snapshots = chooseSnapshots(capture.samples, snapshotCandidates);
      capture.audioDebug = this.opts.audioProbe.getDebug();
      log("turn_finished", performance.now(), {
        timedOut: capture.timedOut,
        error: capture.error,
        blendshapeFrames: capture.blendshapeFrameCount,
        playedBlendshapeFrames: capture.playedBlendshapeFrameCount,
        audioDebug: capture.audioDebug,
      });
      this.opts.session.setSink(null);
      this.opts.audioProbe.setLogHandler(null);
      this.opts.renderer.resetMouth();
    }

    const result: VisualTurnResult = {
      ...capture,
      metrics: computeVisualMetrics(capture),
    };
    this.opts.onTurnComplete?.(result);
    return result;
  }
}

export async function runSequentialTasks<T, R>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await task(items[i]!, i));
  }
  return results;
}

export function clearPendingLipsyncFrames(queue: unknown[]): number {
  const dropped = queue.length;
  queue.length = 0;
  return dropped;
}

export function shouldConsumeLipsyncFrame(opts: {
  speaking: boolean;
  pendingFrames: number;
  elapsedSinceLastFrameMs: number;
  frameIntervalMs: number;
}): boolean {
  return opts.speaking && opts.pendingFrames > 0 && opts.elapsedSinceLastFrameMs >= opts.frameIntervalMs;
}

function chooseSnapshots(samples: readonly VisualTimelineSample[], candidates: readonly VisualSnapshot[]): VisualSnapshot[] {
  if (candidates.length === 0) return [];
  const picked = new Map<string, VisualSnapshot>();
  const nearest = (tMs: number, label: string): void => {
    let best: VisualSnapshot | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.tMs - tMs);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best) picked.set(label, { ...best, label });
  };

  nearest(candidates[0]?.tMs ?? 0, "start");
  const maxAudio = maxSample(samples, (s) => s.audioLevel);
  if (maxAudio) nearest(maxAudio.tMs, "peak audio");
  const maxMouth = maxSample(samples, (s) => Math.max(s.visualMouth, s.pixelMouth));
  if (maxMouth) nearest(maxMouth.tMs, "peak mouth");
  const last = candidates[candidates.length - 1];
  if (last) nearest(last.tMs, "end");
  for (let i = 1; i <= 3; i++) {
    const t = ((last?.tMs ?? 0) * i) / 4;
    nearest(t, `sample ${i}`);
  }
  return [...picked.values()].sort((a, b) => a.tMs - b.tMs);
}

function maxSample(
  samples: readonly VisualTimelineSample[],
  pick: (sample: VisualTimelineSample) => number,
): VisualTimelineSample | null {
  let best: VisualTimelineSample | null = null;
  let bestValue = -Infinity;
  for (const sample of samples) {
    const value = pick(sample);
    if (value > bestValue) {
      best = sample;
      bestValue = value;
    }
  }
  return best;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
