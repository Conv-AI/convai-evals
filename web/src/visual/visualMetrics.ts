import type {
  ActivityWindow,
  AggregateVisualMetrics,
  ShapeCheck,
  VisualLipsyncMetrics,
  VisualTimelineSample,
  VisualTurnCapture,
  VisualTurnResult,
} from "./visualTypes.js";

const DEFAULT_THRESHOLDS = {
  onsetMs: 150,
  offsetMs: 250,
  lagMs: 180,
  correlation: 0.35,
};

export function computeVisualMetrics(capture: VisualTurnCapture): VisualLipsyncMetrics {
  const samples = capture.samples.slice().sort((a, b) => a.tMs - b.tMs);
  const audioWindow = findActivityWindow(samples, (s) => s.audioLevel, 0.015);
  const visualWindow = findActivityWindow(samples, (s) => Math.max(s.visualMouth, s.pixelMouth), 0.02);
  const { bestLagMs, correlation } = findBestLaggedCorrelation(samples);
  const shapeChecks = computeShapeChecks(capture.responseText || capture.prompt, samples);
  const failures: string[] = [];
  const warnings: string[] = [];

  if (capture.timedOut) failures.push("turn timed out before full output completed");
  if (capture.blendshapeFrameCount <= 0) failures.push("no blendshape frames received");
  if (!audioWindow) failures.push("no bot audio activity detected");
  if (!visualWindow) failures.push("no visual mouth activity detected");

  const onsetDeltaMs = audioWindow && visualWindow ? visualWindow.startMs - audioWindow.startMs : null;
  const offsetDeltaMs = audioWindow && visualWindow ? visualWindow.endMs - audioWindow.endMs : null;

  if (onsetDeltaMs !== null && Math.abs(onsetDeltaMs) > DEFAULT_THRESHOLDS.onsetMs) {
    failures.push(`mouth/audio onset differs by ${Math.round(onsetDeltaMs)}ms`);
  }
  if (offsetDeltaMs !== null && Math.abs(offsetDeltaMs) > DEFAULT_THRESHOLDS.offsetMs) {
    failures.push(`mouth/audio offset differs by ${Math.round(offsetDeltaMs)}ms`);
  }
  if (bestLagMs === null || correlation === null) {
    failures.push("not enough samples for audio/mouth correlation");
  } else {
    if (Math.abs(bestLagMs) > DEFAULT_THRESHOLDS.lagMs) {
      failures.push(`best audio/mouth lag is ${Math.round(bestLagMs)}ms`);
    }
    if (correlation < DEFAULT_THRESHOLDS.correlation) {
      failures.push(`audio/mouth correlation is ${correlation.toFixed(2)}`);
    }
  }

  const failedShapeChecks = shapeChecks.filter((c) => c.expected && !c.pass);
  if (failedShapeChecks.length > 0) {
    failures.push(`coarse mouth-shape mismatch: ${failedShapeChecks.map((c) => c.name).join(", ")}`);
  }
  if (!capture.turnStats) {
    warnings.push("blendshape turn stats were not received");
  }
  if (capture.speakingStartMs === undefined) {
    warnings.push("speakingChange:true was not observed");
  }
  if (capture.speakingEndMs === undefined) {
    warnings.push("speakingChange:false was not observed");
  }

  const observedAudioDurationMs = audioWindow ? audioWindow.endMs - audioWindow.startMs : undefined;
  return {
    pass: failures.length === 0,
    audioWindow,
    visualWindow,
    onsetDeltaMs,
    offsetDeltaMs,
    bestLagMs,
    correlation,
    blendshapeCoverage: {
      chunks: capture.blendshapeChunkCount,
      frames: capture.blendshapeFrameCount,
      statsDurationMs: capture.turnStats?.total_audio_duration_ms,
      observedAudioDurationMs,
    },
    shapeChecks,
    warnings,
    failures,
  };
}

export function computeAggregateVisualMetrics(results: readonly VisualTurnResult[]): AggregateVisualMetrics {
  const completed = results.filter((r) => !r.timedOut && !r.error);
  const lagValues = completed
    .map((r) => r.metrics.bestLagMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const onsetValues = completed
    .map((r) => r.metrics.onsetDeltaMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const offsetValues = completed
    .map((r) => r.metrics.offsetDeltaMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const correlations = completed
    .map((r) => r.metrics.correlation)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const warnings = Array.from(new Set(results.flatMap((r) => r.metrics.warnings)));
  return {
    totalTurns: results.length,
    completedTurns: completed.length,
    passedTurns: results.filter((r) => r.metrics.pass).length,
    failedTurns: results.filter((r) => !r.metrics.pass).length,
    audioDetectedTurns: results.filter((r) => r.metrics.audioWindow).length,
    visualDetectedTurns: results.filter((r) => r.metrics.visualWindow).length,
    averageOnsetDeltaMs: meanOrNull(onsetValues),
    averageOffsetDeltaMs: meanOrNull(offsetValues),
    averageLagMs: meanOrNull(lagValues.map(Math.abs)),
    worstLagMs: lagValues.length ? Math.max(...lagValues.map(Math.abs)) : null,
    averageCorrelation: meanOrNull(correlations),
    warnings,
  };
}

function findActivityWindow(
  samples: readonly VisualTimelineSample[],
  pick: (sample: VisualTimelineSample) => number,
  floor: number,
): ActivityWindow | null {
  if (samples.length === 0) return null;
  const values = samples.map(pick);
  const peak = Math.max(...values);
  if (peak <= floor) return null;
  const threshold = Math.max(floor, peak * 0.22);
  const first = findSustainedIndex(values, threshold, 1);
  const last = findSustainedIndex([...values].reverse(), threshold, 1);
  if (first === -1 || last === -1) return null;
  const endIndex = values.length - 1 - last;
  return {
    startMs: samples[first]?.tMs ?? 0,
    endMs: samples[endIndex]?.tMs ?? 0,
    peak,
    threshold,
  };
}

function findSustainedIndex(values: readonly number[], threshold: number, minCount: number): number {
  for (let i = 0; i < values.length; i++) {
    let count = 0;
    for (let j = i; j < values.length && values[j]! >= threshold; j++) count += 1;
    if (count >= minCount) return i;
  }
  return -1;
}

function findBestLaggedCorrelation(samples: readonly VisualTimelineSample[]): {
  bestLagMs: number | null;
  correlation: number | null;
} {
  if (samples.length < 6) return { bestLagMs: null, correlation: null };
  let bestLagMs: number | null = null;
  let bestCorrelation: number | null = null;
  for (let lag = -300; lag <= 300; lag += 30) {
    const paired: Array<[number, number]> = [];
    for (const sample of samples) {
      const audio = interpolate(samples, sample.tMs + lag, (s) => s.audioLevel);
      if (audio !== null) paired.push([sample.visualMouth, audio]);
    }
    if (paired.length < 6) continue;
    const corr = pearson(paired.map((p) => p[0]), paired.map((p) => p[1]));
    if (corr === null) continue;
    if (bestCorrelation === null || corr > bestCorrelation) {
      bestCorrelation = corr;
      bestLagMs = lag;
    }
  }
  return { bestLagMs, correlation: bestCorrelation };
}

function interpolate(
  samples: readonly VisualTimelineSample[],
  tMs: number,
  pick: (sample: VisualTimelineSample) => number,
): number | null {
  if (samples.length === 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || tMs < first.tMs || tMs > last.tMs) return null;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const next = samples[i]!;
    if (tMs <= next.tMs) {
      const span = Math.max(1, next.tMs - prev.tMs);
      const alpha = (tMs - prev.tMs) / span;
      return pick(prev) * (1 - alpha) + pick(next) * alpha;
    }
  }
  return pick(last);
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const meanX = meanOrNull(xs);
  const meanY = meanOrNull(ys);
  if (meanX === null || meanY === null) return null;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? null : num / den;
}

function computeShapeChecks(text: string, samples: readonly VisualTimelineSample[]): ShapeCheck[] {
  const lower = text.toLowerCase();
  const roundedCount = countMatches(lower, /[ouw]/g);
  const smileCount = countMatches(lower, /[ei]/g);
  const closureCount = countMatches(lower, /[mbp]/g);
  const maxFunnel = maxOf(samples, (s) => Math.max(s.mouthFunnel, s.mouthPucker));
  const maxSmile = maxOf(samples, (s) => Math.max(s.mouthSmile, s.mouthStretch));
  const maxClose = maxOf(samples, (s) => s.mouthClose);
  return [
    {
      name: "rounded vowels",
      expected: roundedCount >= 8,
      observed: maxFunnel,
      pass: roundedCount < 8 || maxFunnel >= 0.08,
    },
    {
      name: "wide vowels",
      expected: smileCount >= 8,
      observed: maxSmile,
      pass: smileCount < 8 || maxSmile >= 0.06,
    },
    {
      name: "closed consonants",
      expected: closureCount >= 4,
      observed: maxClose,
      pass: closureCount < 4 || maxClose >= 0.05,
    },
  ];
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function maxOf(samples: readonly VisualTimelineSample[], pick: (sample: VisualTimelineSample) => number): number {
  return samples.length ? Math.max(...samples.map(pick)) : 0;
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
