import assert from "node:assert/strict";
import { computeVisualMetrics } from "./visualMetrics.js";
import { clearPendingLipsyncFrames, runSequentialTasks, shouldConsumeLipsyncFrame } from "./TurnRunner.js";
import type { VisualTimelineSample, VisualTurnCapture } from "./visualTypes.js";

function makeCapture(partial: Partial<VisualTurnCapture>): VisualTurnCapture {
  return {
    turnIndex: 1,
    prompt: "Say hello.",
    responseText: "hello there",
    startedAtIso: new Date(0).toISOString(),
    durationMs: 1400,
    timedOut: false,
    speakingStartMs: 100,
    speakingEndMs: 1100,
    turnEndMs: 1180,
    statsReceivedMs: 1120,
    blendshapeFrameCount: 42,
    blendshapeChunkCount: 6,
    playedBlendshapeFrameCount: 42,
    audioDebug: {
      attachedTracks: 1,
      attachedElements: 1,
      analyserReady: true,
      audioContextState: "running",
      lastLevel: 0,
      maxLevel: 0.16,
      scanCount: 1,
      muted: false,
    },
    debugEvents: [],
    turnStats: {
      fps: 60,
      total_audio_bytes: 1000,
      total_audio_duration_ms: 1000,
      total_blendshapes: 60,
      total_turn_duration_ms: 1200,
    },
    samples: alignedSamples(),
    snapshots: [],
    ...partial,
  };
}

function alignedSamples(opts: { mouthStart?: number; mouthEnd?: number; audioStart?: number; audioEnd?: number } = {}): VisualTimelineSample[] {
  const mouthStart = opts.mouthStart ?? 220;
  const mouthEnd = opts.mouthEnd ?? 980;
  const audioStart = opts.audioStart ?? 200;
  const audioEnd = opts.audioEnd ?? 1000;
  const samples: VisualTimelineSample[] = [];
  for (let t = 0; t <= 1300; t += 50) {
    const audioPhase = envelope(t, audioStart, audioEnd);
    const mouthPhase = envelope(t, mouthStart, mouthEnd);
    samples.push({
      tMs: t,
      audioLevel: audioPhase * 0.16,
      visualMouth: mouthPhase * 0.72,
      pixelMouth: mouthPhase * 0.68,
      jawOpen: mouthPhase * 0.75,
      mouthFunnel: mouthPhase * 0.15,
      mouthPucker: mouthPhase * 0.12,
      mouthSmile: mouthPhase * 0.1,
      mouthStretch: mouthPhase * 0.08,
      mouthClose: mouthPhase * 0.08,
    });
  }
  return samples;
}

function envelope(t: number, start: number, end: number): number {
  if (t < start || t > end) return 0;
  const span = end - start;
  const x = (t - start) / span;
  return Math.sin(Math.PI * x) * 0.45 + 0.55;
}

{
  const metrics = computeVisualMetrics(makeCapture({}));
  assert.equal(metrics.pass, true);
}

{
  const metrics = computeVisualMetrics(makeCapture({ samples: alignedSamples({ mouthStart: 500 }) }));
  assert.equal(metrics.pass, false);
  assert(metrics.failures.some((f) => f.includes("onset")));
}

{
  const metrics = computeVisualMetrics(makeCapture({ samples: alignedSamples({ mouthEnd: 1300 }) }));
  assert.equal(metrics.pass, false);
  assert(metrics.failures.some((f) => f.includes("offset")));
}

{
  const metrics = computeVisualMetrics(makeCapture({ blendshapeFrameCount: 0, blendshapeChunkCount: 0 }));
  assert.equal(metrics.pass, false);
  assert(metrics.failures.some((f) => f.includes("no blendshape")));
}

{
  const samples = alignedSamples().map((s) => ({ ...s, mouthFunnel: 0.01, mouthPucker: 0.01 }));
  const metrics = computeVisualMetrics(makeCapture({ responseText: "blue moon balloon round room soon", samples }));
  assert.equal(metrics.pass, false);
  assert(metrics.failures.some((f) => f.includes("rounded vowels")));
}

{
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const results = await runSequentialTasks([1, 2, 3, 4], async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(item);
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8]);
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(maxActive, 1);
}

{
  assert.equal(
    shouldConsumeLipsyncFrame({
      speaking: false,
      pendingFrames: 14,
      elapsedSinceLastFrameMs: 100,
      frameIntervalMs: 16,
    }),
    false,
  );
  assert.equal(
    shouldConsumeLipsyncFrame({
      speaking: true,
      pendingFrames: 14,
      elapsedSinceLastFrameMs: 100,
      frameIntervalMs: 16,
    }),
    true,
  );
}

{
  const queue = [{ jawOpen: 1 }, { jawOpen: 0.5 }, { jawOpen: 0.2 }];
  assert.equal(clearPendingLipsyncFrames(queue), 3);
  assert.deepEqual(queue, []);
}

console.log("visual lipsync metric tests passed");
