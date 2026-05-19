import type {
  IoLatencyStats,
  PerRowResult,
  RowLatency,
  RowTimestamps,
} from "@convai/evals-shared";

// Pick the first non-null value from a list of candidates.
function firstDefined(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) if (v != null) return v;
  return undefined;
}

export function computeLatency(ts: RowTimestamps): RowLatency {
  const out: RowLatency = {};
  // Keep user-perceived bot-start separate from first audio/TTS chunk. Older harness
  // versions used the same fallback for both, which made ttfb_ms == ttfa_ms.
  const llmStart = firstDefined(ts.t_responding_start, ts.t_first_bot_output);
  const llmEnd = firstDefined(ts.t_responding_end, ts.t_tts_started, ts.t_speaking_start);
  const turnEnd = firstDefined(ts.t_turn_end, ts.t_speaking_end, ts.t_responding_end);

  if (ts.t_input_end != null && ts.t_speaking_start != null) {
    out.ttfb_ms = ts.t_speaking_start - ts.t_input_end;
  }
  if (ts.t_input_end != null && ts.t_tts_started != null) {
    out.ttfa_ms = ts.t_tts_started - ts.t_input_end;
  }
  if (llmStart != null && llmEnd != null && llmEnd >= llmStart) {
    out.llm_ms = llmEnd - llmStart;
  }
  const ttsStart = firstDefined(ts.t_tts_started, ts.t_speaking_start);
  if (ttsStart != null && ts.t_speaking_end != null && ts.t_speaking_end >= ttsStart) {
    out.tts_ms = ts.t_speaking_end - ttsStart;
  }
  if (ts.t_input_end != null && turnEnd != null && turnEnd >= ts.t_input_end) {
    out.end_to_end_ms = turnEnd - ts.t_input_end;
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Bucket label derived from input + observed behavior, used for latency grouping. */
export function ioBucket(row: PerRowResult): string {
  const inK = row.input_kind === "Voice In" ? "voice_in" : row.input_kind === "Text In" ? "text_in" : "context";
  if (row.structure_match.observed_behavior === "respond_with_audio") return `${inK}->voice+anim`;
  if (row.structure_match.observed_behavior === "respond_silent") return `${inK}->respond_silent`;
  if (row.structure_match.observed_behavior === "interrupted_by_priority_event") return `${inK}->interrupted`;
  return `${inK}->silent`;
}

export function summarizeLatency(
  rows: PerRowResult[],
  slaVoiceAnimMs: number,
  slaTextOutMs: number,
): Record<string, IoLatencyStats> {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (r.latency.end_to_end_ms == null) continue;
    const key = ioBucket(r);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r.latency.end_to_end_ms);
  }
  const out: Record<string, IoLatencyStats> = {};
  for (const [key, vals] of buckets) {
    const sorted = [...vals].sort((a, b) => a - b);
    const sla = pickSla(key, slaVoiceAnimMs, slaTextOutMs);
    const p95 = percentile(sorted, 95);
    out[key] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95,
      p99: percentile(sorted, 99),
      sla_pass: sla == null ? null : p95 <= sla,
    };
  }
  return out;
}

export function pickSla(bucket: string, voiceAnimMs: number, textOutMs: number): number | null {
  if (bucket.endsWith("voice+anim")) return voiceAnimMs;
  if (bucket.endsWith("text")) return textOutMs;
  return null;
}

export function rowSlaPass(row: PerRowResult, voiceAnimMs: number, textOutMs: number): boolean | null {
  if (row.latency.end_to_end_ms == null) return null;
  const sla = pickSla(ioBucket(row), voiceAnimMs, textOutMs);
  if (sla == null) return null;
  return row.latency.end_to_end_ms <= sla;
}
