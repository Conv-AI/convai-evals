import type { EndpointKey } from "@convai/evals-shared";

export interface VisualPrompt {
  id: number;
  text: string;
}

export interface VisualRunConfig {
  endpoint: EndpointKey;
  endpointUrl: string;
  characterId: string;
  prompts: VisualPrompt[];
  timeoutMs: number;
  requestCount: number;
  muteAudio: boolean;
  apiKeySource: "file" | "manual";
  characterIdSource: "file" | "manual";
}

export interface LipSyncValues {
  jawOpen: number;
  mouthClose: number;
  mouthFunnel: number;
  mouthPucker: number;
  mouthSmileLeft: number;
  mouthSmileRight: number;
  mouthStretchLeft: number;
  mouthStretchRight: number;
  mouthRollLower: number;
  mouthRollUpper: number;
  tongueOut: number;
}

export interface VisualTimelineSample {
  tMs: number;
  audioLevel: number;
  visualMouth: number;
  pixelMouth: number;
  jawOpen: number;
  mouthFunnel: number;
  mouthPucker: number;
  mouthSmile: number;
  mouthStretch: number;
  mouthClose: number;
}

export interface VisualSnapshot {
  label: string;
  tMs: number;
  dataUrl: string;
  audioLevel: number;
  visualMouth: number;
}

export interface VisualTurnStats {
  fps?: number;
  total_audio_bytes?: number;
  total_audio_duration_ms?: number;
  total_blendshapes?: number;
  total_turn_duration_ms?: number;
}

export interface VisualTurnCapture {
  turnIndex: number;
  prompt: string;
  responseText: string;
  startedAtIso: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  speakingStartMs?: number;
  speakingEndMs?: number;
  turnEndMs?: number;
  statsReceivedMs?: number;
  blendshapeFrameCount: number;
  blendshapeChunkCount: number;
  playedBlendshapeFrameCount: number;
  audioDebug: AudioProbeDebug;
  debugEvents: VisualDebugEvent[];
  turnStats?: VisualTurnStats;
  samples: VisualTimelineSample[];
  snapshots: VisualSnapshot[];
}

export interface VisualDebugEvent {
  tMs: number;
  name: string;
  data?: Record<string, unknown>;
}

export interface AudioProbeDebug {
  attachedTracks: number;
  attachedElements: number;
  analyserReady: boolean;
  audioContextState: string;
  lastAttachError?: string;
  lastPlayError?: string;
  lastLevel: number;
  maxLevel: number;
  scanCount: number;
  muted: boolean;
}

export interface VisualReportPayload {
  runId: string;
  status: "running" | "stopped" | "failed" | "complete";
  updatedAt: string;
  config: VisualRunConfig;
  currentTurn: VisualTurnCapture | null;
  results: VisualTurnResult[];
  aggregate: AggregateVisualMetrics | null;
  error?: string;
}

export interface VisualTurnResult extends VisualTurnCapture {
  metrics: VisualLipsyncMetrics;
}

export interface VisualLipsyncMetrics {
  pass: boolean;
  audioWindow: ActivityWindow | null;
  visualWindow: ActivityWindow | null;
  onsetDeltaMs: number | null;
  offsetDeltaMs: number | null;
  bestLagMs: number | null;
  correlation: number | null;
  blendshapeCoverage: {
    chunks: number;
    frames: number;
    statsDurationMs?: number;
    observedAudioDurationMs?: number;
  };
  shapeChecks: ShapeCheck[];
  warnings: string[];
  failures: string[];
}

export interface ActivityWindow {
  startMs: number;
  endMs: number;
  peak: number;
  threshold: number;
}

export interface ShapeCheck {
  name: string;
  expected: boolean;
  observed: number;
  pass: boolean;
}

export interface AggregateVisualMetrics {
  totalTurns: number;
  completedTurns: number;
  passedTurns: number;
  failedTurns: number;
  audioDetectedTurns: number;
  visualDetectedTurns: number;
  averageOnsetDeltaMs: number | null;
  averageOffsetDeltaMs: number | null;
  averageLagMs: number | null;
  worstLagMs: number | null;
  averageCorrelation: number | null;
  warnings: string[];
}
