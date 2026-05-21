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

const AUDIO_ACTIVE_LEVEL = 0.008;
const AUDIO_QUIET_PAUSE_MS = 600;
const AUDIO_QUIET_FINALIZE_MS = 1600;
const MOUTH_ACTIVE_SIGNAL = 0.025;

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
      if (i > 0) {
        // Cancel any lingering response from the previous turn at the SDK level,
        // then let the trailing turn_end / speakingChange / messagesChange events
        // fire into the now-null sink before we install the new turn's listeners.
        this.opts.session.interrupt();
        await wait(500);
        if (this.opts.signal?.aborted) break;
      }
      const result = await this.runOne(prompts[i]!, i + 1);
      results.push(result);
      if (result.error === "visual lipsync run canceled") break;
    }
    return results;
  }

  private async runOne(prompt: VisualPrompt, turnIndex: number): Promise<VisualTurnResult> {
    if (this.opts.signal?.aborted) throw new Error("visual lipsync run canceled");
    this.opts.renderer.hardResetMouth();
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
    let lipFrameAccumulatorMs = 0;
    let lastLipPlaybackAt = 0;
    let lipPlaybackStarted = false;
    let lipsyncFramesReceived = false;
    let lipsyncQueueDrainedLogged = false;
    let audioEverActive = false;
    let firstAudioActive = 0;
    let lastAudioActive = 0;
    let audioQuietStopped = false;
    let audioQuietFinalized = false;
    // Filter for stale events from the prior turn that the SDK keeps streaming
    // even after we move on (especially after a timeout). Stays false until we
    // see a clear "fresh activity" signal for THIS turn.
    let turnActive = false;
    this.opts.audioProbe.resetTurnStats();
    const pendingFrames: LipSyncValues[] = [];
    const snapshotCandidates: VisualSnapshot[] = [];
    const log = (name: string, atMs = performance.now(), data?: Record<string, unknown>) => {
      capture.debugEvents.push({ tMs: atMs - startedAt, name, data });
      if (capture.debugEvents.length > 1200) capture.debugEvents.shift();
    };

    const sink: VisualSessionSink = {
      onLog: (name, atMs, data) => log(name, atMs, data),
      onSpeakingChange: (isSpeaking, atMs) => {
        if (isSpeaking) {
          turnActive = true;
          speaking = true;
          speakingStarted = true;
          capture.speakingStartMs ??= atMs - startedAt;
        } else {
          if (!turnActive) {
            log("ignored_stale_speaking_false", atMs);
            return;
          }
          speaking = false;
          capture.speakingEndMs ??= atMs - startedAt;
          // CRITICAL: do NOT clear pendingFrames here. The SDK delivers blendshapes
          // ahead of LiveKit audio playback, so frames in the queue correspond to
          // audio still draining from the buffer. Cleanup happens only after a
          // recoverable audio-quiet pause has stayed quiet long enough to finalize.
          log("speaking_stopped", atMs, { pendingFrames: pendingFrames.length });
        }
        lastActivity = atMs;
      },
      onBlendshapeChunk: (frameCount, atMs) => {
        turnActive = true;
        if (audioQuietStopped || audioQuietFinalized) {
          audioQuietStopped = false;
          audioQuietFinalized = false;
          log("lipsync_resumed_on_new_blendshapes", atMs, { frameCount, pendingFrames: pendingFrames.length });
        }
        capture.blendshapeChunkCount += 1;
        capture.blendshapeFrameCount += frameCount;
        lastBlendshape = atMs;
        if (!audioQuietStopped) lastActivity = atMs;
      },
      onBlendshapeFrames: (values, atMs) => {
        if (!turnActive) {
          log("ignored_stale_blendshape_frames", atMs, { frameCount: values.length });
          return;
        }
        pendingFrames.push(...values);
        lipsyncFramesReceived ||= values.length > 0;
        lastBlendshape = atMs;
      },
      onBlendshapeStats: (stats: VisualTurnStats | undefined, atMs) => {
        if (!turnActive) {
          log("ignored_stale_stats", atMs);
          return;
        }
        capture.turnStats = stats;
        capture.statsReceivedMs = atMs - startedAt;
        statsReceived = true;
        lastActivity = atMs;
      },
      onTurnEnd: (atMs) => {
        if (!turnActive) {
          log("ignored_stale_turn_end", atMs);
          return;
        }
        turnEnded = true;
        capture.turnEndMs = atMs - startedAt;
        lastActivity = atMs;
      },
      onNoResponse: (atMs) => {
        // Legitimate "bot had no response" — counts as activation since it's an
        // authoritative signal from the SDK for this turn.
        turnActive = true;
        noResponse = true;
        turnEnded = true;
        capture.turnEndMs = atMs - startedAt;
        lastActivity = atMs;
      },
      onResponseText: (text, streaming, atMs) => {
        // The SDK's messagesChange replays the full message list, which can include
        // the previous turn's final text. The "fresh turn" signal is streaming=true
        // with chars=0 (the streamed response is just starting), or any text once
        // turnActive has been latched by another handler.
        if (!turnActive) {
          if (streaming && text.length === 0) {
            turnActive = true;
            capture.responseText = text;
            responseStreaming = streaming;
            lastActivity = atMs;
          } else {
            log("ignored_stale_response_text", atMs, { chars: text.length, streaming });
          }
          return;
        }
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
      if (audioLevel > AUDIO_ACTIVE_LEVEL) {
        const resumedAfterQuiet = audioQuietStopped || audioQuietFinalized;
        if (!audioEverActive) firstAudioActive = now;
        audioEverActive = true;
        lastAudioActive = now;
        audioQuietStopped = false;
        audioQuietFinalized = false;
        if (resumedAfterQuiet) {
          log("lipsync_resumed_after_audio_quiet", now, {
            pendingFrames: pendingFrames.length,
            audioLevel,
          });
        }
      }
      const audioQuietFor = audioEverActive ? now - lastAudioActive : 0;
      // Short quiet gaps are common inside a generated response. Pause the mouth
      // without dropping queued frames, then only discard them after sustained
      // quiet once the turn has otherwise completed.
      const expectedAudioDurationMs = capture.turnStats?.total_audio_duration_ms;
      const audioPlaybackElapsedMs = firstAudioActive > 0 ? now - firstAudioActive : 0;
      const expectedAudioDrained =
        expectedAudioDurationMs === undefined || audioPlaybackElapsedMs >= expectedAudioDurationMs;
      const canFinalizeQuietLipsync =
        expectedAudioDrained &&
        (noResponse || turnEnded || (statsReceived && speakingStarted && !speaking && !responseStreaming));
      const quietAction = getAudioQuietLipsyncAction({
        audioEverActive,
        audioQuietForMs: audioQuietFor,
        pendingFrames: pendingFrames.length,
        mouthSignal: this.opts.renderer.getMouthSignal(),
        paused: audioQuietStopped,
        turnComplete: canFinalizeQuietLipsync,
      });
      if (quietAction === "pause") {
        this.opts.renderer.resetMouth();
        audioQuietStopped = true;
        log("lipsync_paused_on_audio_quiet", now, {
          pendingFrames: pendingFrames.length,
          audioQuietForMs: Math.round(audioQuietFor),
          audioLevel,
        });
      } else if (quietAction === "finalize") {
        const dropped = clearPendingLipsyncFrames(pendingFrames);
        this.opts.renderer.resetMouth();
        audioQuietStopped = true;
        audioQuietFinalized = true;
        log("lipsync_finalized_on_audio_quiet", now, {
          droppedPendingFrames: dropped,
          audioQuietForMs: Math.round(audioQuietFor),
          audioPlaybackElapsedMs: Math.round(audioPlaybackElapsedMs),
          expectedAudioDurationMs,
          audioLevel,
        });
      }
      const frameInterval = capture.turnStats?.fps ? 1000 / capture.turnStats.fps : 1000 / 60;
      // Consume whenever there are frames and audio hasn't ended. This drains the
      // LiveKit audio-buffer's worth of pre-delivered blendshapes in sync with playback,
      // regardless of speaking_change toggles.
      if (!audioQuietStopped && !audioQuietFinalized && pendingFrames.length > 0) {
        if (!lipPlaybackStarted) {
          lipPlaybackStarted = true;
          lastLipPlaybackAt = now;
          lipFrameAccumulatorMs = 0;
          log("lipsync_playback_started", now, {
            frameIntervalMs: frameInterval,
            pendingFrames: pendingFrames.length,
            fps: capture.turnStats?.fps ?? 60,
          });
        } else {
          const drain = computeLipsyncDrainCount({
            accumulatorMs: lipFrameAccumulatorMs,
            elapsedMs: now - lastLipPlaybackAt,
            frameIntervalMs: frameInterval,
            pendingFrames: pendingFrames.length,
          });
          lipFrameAccumulatorMs = drain.nextAccumulatorMs;
          lastLipPlaybackAt = now;
          let latest: LipSyncValues | null = null;
          let drained = 0;
          while (drained < drain.frameCount && pendingFrames.length > 0) {
            latest = pendingFrames.shift() ?? null;
            drained += 1;
          }
          if (latest) {
            this.opts.renderer.setLipValues(latest);
            capture.playedBlendshapeFrameCount += drained;
          }
          if (lipsyncFramesReceived && !lipsyncQueueDrainedLogged && pendingFrames.length === 0) {
            lipsyncQueueDrainedLogged = true;
            log("lipsync_queue_drained", now, {
              playedFrames: capture.playedBlendshapeFrameCount,
              audioLevel,
              audioQuietForMs: Math.round(audioQuietFor),
              audioPlaybackElapsedMs: Math.round(audioPlaybackElapsedMs),
              lipFrameAccumulatorMs: Math.round(lipFrameAccumulatorMs * 1000) / 1000,
            });
          }
        }
      } else if (lipPlaybackStarted) {
        lastLipPlaybackAt = now;
      }
      if (speakingStarted && !speaking && pendingFrames.length === 0 && (audioQuietStopped || audioQuietFinalized)) {
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
          audioQuietFinalized ||
          (audioQuietStopped && pendingFrames.length === 0) ||
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
        pendingFrames: pendingFrames.length,
        lipFrameAccumulatorMs: Math.round(lipFrameAccumulatorMs * 1000) / 1000,
        lipPlaybackStarted,
        audioQuietStopped,
        audioQuietFinalized,
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

export function computeLipsyncDrainCount(opts: {
  accumulatorMs: number;
  elapsedMs: number;
  frameIntervalMs: number;
  pendingFrames: number;
}): { frameCount: number; nextAccumulatorMs: number } {
  if (opts.pendingFrames <= 0 || opts.frameIntervalMs <= 0) {
    return { frameCount: 0, nextAccumulatorMs: 0 };
  }
  const accumulatedMs = Math.max(0, opts.accumulatorMs) + Math.max(0, opts.elapsedMs);
  const elapsedFrameCount = Math.floor(accumulatedMs / opts.frameIntervalMs);
  const frameCount = Math.min(opts.pendingFrames, elapsedFrameCount);
  if (frameCount === opts.pendingFrames) {
    return { frameCount, nextAccumulatorMs: 0 };
  }
  return { frameCount, nextAccumulatorMs: accumulatedMs - frameCount * opts.frameIntervalMs };
}

export function getAudioQuietLipsyncAction(opts: {
  audioEverActive: boolean;
  audioQuietForMs: number;
  pendingFrames: number;
  mouthSignal: number;
  paused: boolean;
  turnComplete: boolean;
}): "none" | "pause" | "finalize" {
  if (!opts.audioEverActive) return "none";
  const hasLipsyncWork = opts.pendingFrames > 0 || opts.mouthSignal > MOUTH_ACTIVE_SIGNAL;
  if (!hasLipsyncWork) return "none";
  if (opts.turnComplete && opts.audioQuietForMs >= AUDIO_QUIET_FINALIZE_MS) return "finalize";
  if (!opts.paused && opts.audioQuietForMs >= AUDIO_QUIET_PAUSE_MS) return "pause";
  return "none";
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
