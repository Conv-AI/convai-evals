import type { PerRowResult, ReportPayload } from "@convai/evals-shared";

export function downloadJson(report: ReportPayload): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  triggerDownload(blob, `report-${report.run_metadata.run_id}.json`);
}

export function downloadCsv(report: ReportPayload): void {
  const headers = [
    "test_id",
    "session_id",
    "sequence_index",
    "input_kind",
    "expected_behavior",
    "observed_behavior",
    "failure_reason",
    "structure_overall",
    "structure_behavior",
    "structure_llm_call",
    "structure_verbal",
    "structure_events",
    "ttfb_ms",
    "ttfa_ms",
    "llm_ms",
    "tts_ms",
    "end_to_end_ms",
    "server_e2e_ms",
    "critical_stage",
    "sla_pass",
    "backend_session_id",
    "character_session_id",
    "turn_id",
    "character_id",
    "client_event_id",
    "dispatch_epoch_ms",
    "outbound_metadata_injected",
    "attribution_response",
    "attribution_transcript",
    "was_canceled",
    "bot_transcript",
    "judge_overall",
    "judge_rationale",
    "diagnostics_bundle_path",
    "diagnostics_provider",
    "diagnostics_item_count",
    "diagnostics_error_count",
  ];
  const rows = report.per_row.map((r) => csvRow(r));
  const text = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([text], { type: "text/csv" });
  triggerDownload(blob, `report-${report.run_metadata.run_id}.csv`);
}

function csvRow(r: PerRowResult): string[] {
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    r.test_id,
    r.session_id,
    String(r.sequence_index),
    r.input_kind,
    r.expected.behavior,
    r.structure_match.observed_behavior,
    r.failure_reason,
    String(r.structure_match.overall),
    String(r.structure_match.behavior),
    String(r.structure_match.llm_call),
    String(r.structure_match.verbal),
    String(r.structure_match.events),
    fmt(r.latency.ttfb_ms),
    fmt(r.latency.ttfa_ms),
    fmt(r.latency.llm_ms),
    fmt(r.latency.tts_ms),
    fmt(r.latency.end_to_end_ms),
    fmt(r.server_e2e_ms),
    esc(r.turn_trace?.critical_stage ?? ""),
    r.sla_pass == null ? "" : String(r.sla_pass),
    esc(r.backend?.session_id ?? ""),
    esc(r.backend?.character_session_id ?? ""),
    esc(r.backend?.turn_id ?? ""),
    esc(r.backend?.character_id ?? ""),
    esc(r.correlation?.client_event_id ?? ""),
    r.correlation?.dispatch_epoch_ms == null ? "" : String(r.correlation.dispatch_epoch_ms),
    r.correlation?.outbound_metadata == null ? "" : String(r.correlation.outbound_metadata.injected),
    esc(r.correlation?.attribution.response ?? ""),
    esc(r.correlation?.attribution.transcript ?? ""),
    r.was_canceled == null ? "" : String(r.was_canceled),
    esc(r.observed.bot_transcript ?? ""),
    r.judge ? String(r.judge.overall) : "",
    esc(r.judge?.rationale ?? ""),
    esc(r.diagnostics?.bundle_path ?? ""),
    r.diagnostics?.provider ?? "",
    r.diagnostics ? String(r.diagnostics.item_count) : "",
    r.diagnostics ? String(r.diagnostics.error_count) : "",
  ];
}

function fmt(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  return v.toFixed(1);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
