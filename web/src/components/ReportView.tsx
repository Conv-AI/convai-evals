import { Fragment, useMemo, useState, useCallback } from "react";
import {
  isFailureReasonFailure,
  type DiagnosticsSummary,
  type FailureReason,
  type PerRowResult,
  type ReportPayload,
} from "@convai/evals-shared";
import { downloadCsv, downloadJson } from "../report/exporters.js";

interface Props {
  report: ReportPayload;
}

export function ReportView({ report }: Props): JSX.Element {
  const m = report.run_metadata;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failuresOnly, setFailuresOnly] = useState(false);

  const visibleRows = useMemo(
    () =>
      failuresOnly
        ? report.per_row.filter((r) => isFailureReasonFailure(r.failure_reason))
        : report.per_row,
    [report.per_row, failuresOnly],
  );

  const toggleRow = (testId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(testId)) next.delete(testId);
      else next.add(testId);
      return next;
    });
  };

  const failureCounts = useMemo(() => {
    const out: Partial<Record<FailureReason, number>> = {};
    for (const r of report.per_row) {
      out[r.failure_reason] = (out[r.failure_reason] ?? 0) + 1;
    }
    return out;
  }, [report.per_row]);

  return (
    <div className="card stack-lg">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div>
          <h1 style={{ marginBottom: 8 }}>Report</h1>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span className="badge badge-primary">{m.endpoint}</span>
            <span className="badge badge-neutral">{m.row_count} rows</span>
            <span className="badge badge-neutral">{m.session_count} sessions</span>
            <span className="badge badge-neutral">concurrency {m.concurrency}</span>
            {m.canceled && <span className="badge badge-warn">canceled</span>}
            {m.partial && <span className="badge badge-warn">partial</span>}
            <span className="muted small">
              {new Date(m.timestamp).toLocaleString()} · character <code>{m.characterId}</code>
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => downloadJson(report)}>Download JSON</button>
          <button className="primary-outline" onClick={() => downloadCsv(report)}>
            Download CSV
          </button>
        </div>
      </header>
      <h2>Summary</h2>
      <p>
        Structure pass rate:{" "}
        <strong>{(report.summary.structure_pass_rate_overall * 100).toFixed(1)}%</strong>
      </p>
      {report.summary.telemetry_id_coverage && (
        <p className="muted small">
          telemetry IDs: {report.summary.telemetry_id_coverage.rows_with_client_event_id} client events ·{" "}
          {report.summary.telemetry_id_coverage.unique_character_session_ids} character sessions ·{" "}
          {report.summary.telemetry_id_coverage.unique_turn_ids} turn traces
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {([
          "pass",
          "interrupted_by_priority_event",
          "sla_miss",
          "behavior_mismatch_by_design",
          "behavior_mismatch_error",
          "timeout",
          "connection_error",
        ] as FailureReason[]).map(
          (key) => {
            const count = failureCounts[key] ?? 0;
            if (count === 0) return null;
            return (
              <span key={key} className={`badge ${failureBadgeClass(key)}`}>
                {key}: {count}
              </span>
            );
          },
        )}
      </div>
      <h2>Per-bucket structure</h2>
      <table>
        <thead>
          <tr>
            <th>bucket</th>
            <th>passed / total</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
            <th>SLA pass</th>
          </tr>
        </thead>
        <tbody>
          {report.per_bucket.map((b) => (
            <tr key={b.bucket}>
              <td>
                <code>{b.bucket}</code>
              </td>
              <td>
                {b.structure_passed} / {b.total}
              </td>
              <td>{fmt(b.p50_ms)}</td>
              <td>{fmt(b.p95_ms)}</td>
              <td>{fmt(b.p99_ms)}</td>
              <td>
                {b.latency_pass_rate == null ? "—" : `${(b.latency_pass_rate * 100).toFixed(0)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Latency by I/O type</h2>
      <table>
        <thead>
          <tr>
            <th>bucket</th>
            <th>count</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
            <th>SLA</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(report.summary.latency_by_io_type).map(([k, v]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{v.count}</td>
              <td>{fmt(v.p50)}</td>
              <td>{fmt(v.p95)}</td>
              <td>{fmt(v.p99)}</td>
              <td>
                {v.sla_pass == null ? (
                  <span className="muted">—</span>
                ) : v.sla_pass ? (
                  <span className="badge badge-pass">pass</span>
                ) : (
                  <span className="badge badge-fail">fail</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.summary.judge_mean_scores && (
        <>
          <h2>Judge mean scores</h2>
          <table>
            <tbody>
              {Object.entries(report.summary.judge_mean_scores).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{typeof v === "number" ? v.toFixed(2) : v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Per-row</h2>
        <label style={{ fontWeight: "normal", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(e) => setFailuresOnly(e.target.checked)}
          />{" "}
          Show failures only ({report.per_row.filter((r) => isFailureReasonFailure(r.failure_reason)).length})
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>test_id</th>
            <th>session</th>
            <th>kind</th>
            <th>resolved</th>
            <th>expected</th>
            <th>observed</th>
            <th>failure</th>
            <th>structure</th>
            <th>e2e ms</th>
            <th>server e2e</th>
            <th>sla</th>
            <th>judge</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((r) => {
            const isOpen = expanded.has(r.test_id);
            return (
              <Fragment key={r.test_id}>
                <tr
                  className="row-clickable"
                  onClick={() => toggleRow(r.test_id)}
                >
                  <td style={{ width: 16 }}>{isOpen ? "▼" : "▶"}</td>
                  <td>
                    <code>{r.test_id}</code>
                  </td>
                  <td>
                    <code>{r.session_id}</code>
                  </td>
                  <td>{r.input_kind}</td>
                  <td>
                    {r.resolved_expectation ? (
                      <span
                        className={`badge ${resolvedBadgeClass(r.resolved_expectation.category)}`}
                        title={r.resolved_expectation.resolution}
                      >
                        {r.resolved_expectation.category}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{r.expected.behavior}</td>
                  <td>{r.structure_match.observed_behavior}</td>
                  <td>
                    <span className={`badge ${failureBadgeClass(r.failure_reason)}`}>
                      {r.failure_reason}
                    </span>
                  </td>
                  <td>
                    {r.structure_match.overall ? (
                      <span className="badge badge-pass">pass</span>
                    ) : (
                      <span className="badge badge-fail">fail</span>
                    )}
                  </td>
                  <td>{fmt(r.latency.end_to_end_ms)}</td>
                  <td>{fmt(r.server_e2e_ms)}</td>
                  <td>
                    {r.sla_pass == null ? (
                      <span className="muted">—</span>
                    ) : r.sla_pass ? (
                      <span className="badge badge-pass">pass</span>
                    ) : (
                      <span className="badge badge-fail">fail</span>
                    )}
                  </td>
                  <td>{r.judge ? r.judge.overall.toFixed(1) : "—"}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={13}>
                      <RowDetailPanel row={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowDetailPanel({ row }: { row: PerRowResult }): JSX.Element {
  const slaMs =
    row.sla_pass === false && row.latency.end_to_end_ms != null
      ? row.latency.end_to_end_ms
      : null;
  const rationale = failureRationale(row, slaMs);
  return (
    <div className="row-detail-panel">
      <div className="row-detail-section">
        <h4>Failure rationale</h4>
        <p style={{ margin: 0 }}>{rationale}</p>
      </div>

      {row.resolved_expectation && (
        <div className="row-detail-section">
          <h4>Received state &amp; resolved directive</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, fontSize: 12 }}>
            <IdCell label="run_llm" value={row.resolved_expectation.run_llm} />
            <IdCell label="resolved_to" value={`${row.resolved_expectation.category} (${row.resolved_expectation.resolution})`} />
            <IdCell label="bot_busy_when_received" value={String(row.resolved_expectation.bot_busy)} />
            <IdCell label="user_speaking_when_received" value={String(row.resolved_expectation.user_speaking)} />
          </div>
        </div>
      )}

      <div className="row-detail-section">
        <h4>Backend identifiers</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, fontSize: 12 }}>
          <IdCell label="session_id" value={row.backend?.session_id} />
          <IdCell label="character_session_id" value={row.backend?.character_session_id} />
          <IdCell label="turn_id" value={row.backend?.turn_id} />
          <IdCell label="character_id" value={row.backend?.character_id} />
        </div>
      </div>

      {row.correlation && (
        <div className="row-detail-section">
          <h4>Correlation</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, fontSize: 12 }}>
            <IdCell label="client_event_id" value={row.correlation.client_event_id} />
            <IdCell label="dispatch_time" value={row.correlation.dispatch_epoch_ms ? new Date(row.correlation.dispatch_epoch_ms).toISOString() : undefined} />
            <IdCell label="response_attribution" value={row.correlation.attribution.response} />
            <IdCell label="transcript_attribution" value={row.correlation.attribution.transcript} />
            <IdCell
              label="outbound_metadata"
              value={row.correlation.outbound_metadata
                ? row.correlation.outbound_metadata.injected
                  ? `injected:${row.correlation.outbound_metadata.message_type ?? "unknown"}`
                  : "not_injected"
                : undefined}
            />
          </div>
        </div>
      )}

      {row.diagnostics && (
        <div className="row-detail-section">
          <DiagnosticsPanel diag={row.diagnostics} />
        </div>
      )}

      {(row.observed.bot_transcript || row.observed.user_transcript) && (
        <div className="row-detail-section">
          <h4>Transcripts</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div className="muted small">user</div>
              <pre style={{ whiteSpace: "pre-wrap" }}>{row.observed.user_transcript || "—"}</pre>
            </div>
            <div>
              <div className="muted small">bot</div>
              <pre style={{ whiteSpace: "pre-wrap" }}>{row.observed.bot_transcript || "—"}</pre>
            </div>
          </div>
        </div>
      )}

      <div className="row-detail-section">
        <h4>Event timeline (client + server clocks are independent; offsets are per-side)</h4>
        <div className="row-detail-timeline">
          <div>
            <div className="muted small">client (worker)</div>
            <div className="row-detail-timeline-col">
              <ClientEventList row={row} />
            </div>
          </div>
          <div>
            <div className="muted small">server (turn-trace)</div>
            <div className="row-detail-timeline-col">
              <ServerEventList row={row} />
            </div>
          </div>
        </div>
      </div>

      {row.turn_trace && (
        <div className="row-detail-section">
          <h4>Turn-trace summary</h4>
          <div style={{ fontSize: 12 }}>
            <p style={{ margin: "0 0 6px 0" }}>
              critical stage: <code>{row.turn_trace.critical_stage ?? "—"}</code> ·{" "}
              {fmt(row.turn_trace.critical_stage_ms)} ms · e2e {fmt(row.turn_trace.e2e_ms)} ms
            </p>
            <table style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>segment</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(row.turn_trace.segments_ms ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([seg, ms]) => (
                    <tr key={seg}>
                      <td>
                        <code>{seg}</code>
                      </td>
                      <td>{ms.toFixed(1)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface AnalyticsApiResult {
  endpoint: string;
  status: number;
  ok: boolean;
  body?: unknown;
  error?: string;
}
interface DiagBundle {
  analytics_api: {
    session?: AnalyticsApiResult;
    interaction?: AnalyticsApiResult;
    skipped?: string;
  };
  fetch_meta?: { fetch_duration_ms: number; errors: string[] };
}

function DiagnosticsPanel({ diag }: { diag: DiagnosticsSummary }): JSX.Element {
  const [bundle, setBundle] = useState<DiagBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);

  const loadBundle = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/diagnostics/bundle?path=${encodeURIComponent(diag.bundle_path)}`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setBundle(await res.json() as DiagBundle);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [diag.bundle_path]);

  if (diag.skipped) {
    return (
      <>
        <h4>Diagnostics</h4>
        <span className="muted small">skipped: {diag.skipped}</span>
      </>
    );
  }

  return (
    <>
      <h4 style={{ marginBottom: 8 }}>Diagnostics</h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <span className="badge badge-neutral">{diag.provider}</span>
        <span className="badge badge-neutral">{diag.item_count} lookups</span>
        {diag.warning_count > 0 && <span className="badge badge-warn">{diag.warning_count} warnings</span>}
        {diag.error_count > 0 && <span className="badge badge-fail">{diag.error_count} errors</span>}
        {diag.errors?.map((e, i) => <span key={i} className="badge badge-fail">{e}</span>)}
        {!bundle && !loading && (
          <button style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => { void loadBundle(); }}>
            Load logs
          </button>
        )}
        {loading && <span className="muted small">loading…</span>}
        {loadError && <span className="badge badge-fail">fetch error: {loadError}</span>}
      </div>

      {bundle && (
        <div style={{ fontSize: 12 }}>
          {bundle.fetch_meta?.errors && bundle.fetch_meta.errors.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              {bundle.fetch_meta.errors.map((e, i) => (
                <div key={i} className="badge badge-fail" style={{ marginRight: 4 }}>{e}</div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 6 }}>
            <button
              style={{ fontSize: 12, padding: "2px 10px", marginRight: 8 }}
              onClick={() => setBundleOpen((o) => !o)}
            >
              {bundleOpen ? "▼" : "▶"} Analytics API payload
            </button>
          </div>
          {bundleOpen && (
            <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, marginBottom: 8 }}>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(bundle.analytics_api, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ClientEventList({ row }: { row: PerRowResult }): JSX.Element {
  // Client events come in via the worker's event captures. We only have names + booleans
  // on PerRowResult; raw timestamps live on observation but aren't carried in PerRowResult.
  // Use the row's timestamps dict as a proxy timeline.
  const ts = row.timestamps;
  const t0 = ts.t_input_start;
  const fmtOffset = (v: number | undefined) =>
    v == null || t0 == null ? "—" : `${(v - t0).toFixed(0)} ms`;
  const items: Array<{ name: string; ts?: number }> = [
    { name: "input_start", ts: ts.t_input_start },
    { name: "input_end", ts: ts.t_input_end },
    { name: "responding_start", ts: ts.t_responding_start },
    { name: "first_bot_output", ts: ts.t_first_bot_output },
    { name: "tts_started", ts: ts.t_tts_started },
    { name: "speaking_start", ts: ts.t_speaking_start },
    { name: "speaking_end", ts: ts.t_speaking_end },
    { name: "responding_end", ts: ts.t_responding_end },
    { name: "turn_end", ts: ts.t_turn_end },
  ];
  return (
    <>
      {items
        .filter((i) => i.ts != null)
        .map((i) => (
          <div key={i.name} className="row-detail-timeline-row">
            <span>{i.name}</span>
            <span className="ts">{fmtOffset(i.ts)}</span>
          </div>
        ))}
      <div className="row-detail-timeline-row" style={{ marginTop: 6 }}>
        <span className="muted">events seen:</span>
        <span className="ts">{row.observed.events.length}</span>
      </div>
    </>
  );
}

function ServerEventList({ row }: { row: PerRowResult }): JSX.Element {
  const trace = row.turn_trace;
  if (!trace) {
    return <div className="muted small">no server trace (older backend or debug disabled)</div>;
  }
  // event_timestamps_ms is absolute ms; normalize to first event.
  const events = Object.entries(trace.event_timestamps_ms ?? {}).sort((a, b) => a[1] - b[1]);
  if (events.length === 0) {
    // Fall back to relative-µs map.
    const rel = Object.entries(trace.events ?? {}).sort((a, b) => a[1] - b[1]);
    if (rel.length === 0) return <div className="muted small">trace has no events</div>;
    const base = rel[0]![1];
    return (
      <>
        {rel.map(([name, us]) => (
          <div key={name} className="row-detail-timeline-row">
            <span>{name}</span>
            <span className="ts">{((us - base) / 1000).toFixed(1)} ms</span>
          </div>
        ))}
      </>
    );
  }
  const base = events[0]![1];
  return (
    <>
      {events.map(([name, ms]) => (
        <div key={name} className="row-detail-timeline-row">
          <span>{name}</span>
          <span className="ts">{(ms - base).toFixed(0)} ms</span>
        </div>
      ))}
    </>
  );
}

function IdCell({ label, value }: { label: string; value: string | undefined }): JSX.Element {
  const v = value && value.length > 0 ? value : "—";
  return (
    <div>
      <div className="muted small">{label}</div>
      <code style={{ wordBreak: "break-all" }}>{v}</code>
    </div>
  );
}

function resolvedBadgeClass(category: string): string {
  switch (category) {
    case "respond":
      return "badge-pass";
    case "silent":
      return "badge-info";
    case "discretionary":
      return "badge-warn";
    default:
      return "badge-info";
  }
}

function failureBadgeClass(r: FailureReason): string {
  switch (r) {
    case "pass":
      return "badge-pass";
    case "sla_miss":
      return "badge-warn";
    case "interrupted_by_priority_event":
    case "behavior_mismatch_by_design":
      return "badge-info";
    case "behavior_mismatch_error":
    case "timeout":
    case "connection_error":
      return "badge-fail";
  }
}

function failureRationale(row: PerRowResult, slaMs: number | null): string {
  const expected = row.expected.behavior;
  const observed = row.structure_match.observed_behavior;
  switch (row.failure_reason) {
    case "pass":
      return "Behavior and SLA both passed.";
    case "interrupted_by_priority_event":
      return "A later run_llm=true context update preempted this in-flight response. This is expected priority behavior and is not counted as a failure.";
    case "sla_miss": {
      const e2e = row.latency.end_to_end_ms;
      return `Behavior matched (${expected}) but end-to-end latency${
        e2e != null ? ` (${e2e.toFixed(0)} ms)` : ""
      } exceeded the configured SLA${slaMs != null ? ` (${slaMs.toFixed(0)} ms observed)` : ""}.`;
    }
    case "behavior_mismatch_by_design":
      if (row.dispatched_mid_turn) {
        return `Dynamic Context dispatched while a previous bot turn was in flight; server collapsed this update to no_call (expected behavior for run_llm=auto / undefined). Expected ${expected}.`;
      }
      if (row.was_canceled) {
        return `Server marked this turn as canceled (interrupt or override) before completion. Observed ${observed}; expected ${expected}.`;
      }
      return `Observed ${observed} differs from expected ${expected}, but a by-design explanation was found.`;
    case "timeout":
      return `Row expected ${expected} but no bot-side events fired before the wait window closed. Likely server didn't process the input, or the response is in flight beyond timeout.`;
    case "connection_error":
      return `Run was canceled or the worker disconnected before this row could complete.`;
    case "behavior_mismatch_error":
      return `Expected ${expected}; observed ${observed}. No by-design explanation matched (dispatched_mid_turn=${
        row.dispatched_mid_turn ? "true" : "false"
      }, was_canceled=${row.was_canceled ? "true" : "false"}).`;
  }
}

function fmt(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(0);
}
