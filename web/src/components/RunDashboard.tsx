import { useEffect, useState } from "react";
import type { WsServerToClient } from "@convai/evals-shared";

interface Props {
  events: WsServerToClient[];
  ttsProgress: { done: number; total: number } | null;
  ttsComplete: boolean;
  perSession: Record<string, { dispatched: number; complete: number }>;
  totalRows: number;
  startedAt: number | null;
  expectedTotalMs: number | null;
  onStop?: () => void;
}

export function RunDashboard({
  events,
  ttsProgress,
  ttsComplete,
  perSession,
  totalRows,
  startedAt,
  expectedTotalMs,
  onStop,
}: Props): JSX.Element {
  const [stopRequested, setStopRequested] = useState(false);
  // Phase weights: TTS pre-gen gets 30% of the bar ONLY when it actually has work to do.
  // For runs with zero Voice In rows (e.g. all Text In or Dynamic Context) the entire bar
  // tracks session execution, so the bar starts at 0% instead of jumping to 30% on launch.
  const ttsTotal = ttsProgress?.total ?? 0;
  const ttsDone = ttsProgress?.done ?? 0;
  const hasTts = ttsTotal > 0;
  const ttsWeight = hasTts ? 0.3 : 0;
  const execWeight = 1 - ttsWeight;
  const ttsFraction = hasTts ? ttsDone / ttsTotal : 1;
  const completedRows = Object.values(perSession).reduce((sum, v) => sum + v.complete, 0);
  const execFraction = totalRows === 0 ? 0 : completedRows / totalRows;
  // Clamp to [0, 1] so the bar can never overshoot if event counts drift.
  const rawFraction = (ttsComplete ? 1 : ttsFraction) * ttsWeight + execFraction * execWeight;
  const overallFraction = Math.min(1, Math.max(0, rawFraction));
  const overallPct = Math.round(overallFraction * 100);
  const phase = !ttsComplete && hasTts ? "TTS pre-generation" : "Session execution";

  // Tick once per second so elapsed/ETA stay live without needing new server events.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = startedAt == null ? 0 : Date.now() - startedAt;
  // Prefer the deterministic up-front estimate (computed from row timestamps + concurrency
  // + TTS provider). It's accurate from t=0 and doesn't lurch around as completed-rows tick.
  // Fall back to the heuristic (elapsed / progress) only if we don't have an estimate.
  let etaMs: number | null = null;
  if (expectedTotalMs != null && overallFraction < 1) {
    etaMs = Math.max(0, expectedTotalMs - elapsedMs);
  } else if (overallFraction > 0.02 && overallFraction < 1) {
    etaMs = (elapsedMs / overallFraction) * (1 - overallFraction);
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h2 style={{ margin: 0 }}>Run progress</h2>
        {onStop && (
          <button
            type="button"
            className="danger"
            disabled={stopRequested}
            onClick={() => {
              setStopRequested(true);
              onStop();
            }}
          >
            {stopRequested ? "Stopping…" : "Stop run"}
          </button>
        )}
      </div>
      <div className="dashboard-headline">
        <div className="dashboard-pct">{overallPct}%</div>
        <div className="dashboard-meta">
          <span className="pulse-dot" style={{ marginRight: 8 }} />
          {phase}
          {etaMs != null && (
            <span style={{ marginLeft: 12 }}>
              · elapsed {fmtDuration(elapsedMs)} · ETA {fmtDuration(etaMs)}
            </span>
          )}
        </div>
      </div>
      <div className="progress-bar">
        <div style={{ width: `${overallPct}%` }} />
      </div>

      {ttsTotal > 0 && (
        <div style={{ marginTop: 12 }}>
          <p>
            TTS pre-generation: {ttsDone} / {ttsTotal}
          </p>
          <div className="progress-bar">
            <div style={{ width: `${(ttsDone / Math.max(1, ttsTotal)) * 100}%` }} />
          </div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <p>
          Rows complete: {completedRows} / {totalRows}
        </p>
        <div className="progress-bar">
          <div style={{ width: `${execFraction * 100}%` }} />
        </div>
      </div>
      <h2>Sessions</h2>
      <table>
        <thead>
          <tr>
            <th>session_id</th>
            <th>dispatched</th>
            <th>complete</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(perSession).map(([s, v]) => (
            <tr key={s}>
              <td>
                <code>{s}</code>
              </td>
              <td>{v.dispatched}</td>
              <td>{v.complete}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Recent events</h2>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {events.slice(-50).map((e, i) => (
          <div key={i} className="log-line">
            {summarizeEvent(e)}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

function summarizeEvent(e: WsServerToClient): string {
  switch (e.type) {
    case "tts_progress":
      return `tts ${e.done}/${e.total}`;
    case "tts_complete":
      return "tts done";
    case "tts_error":
      return `tts error: ${e.message}`;
    case "row_dispatched":
      return `disp ${e.session_id} #${e.sequence_index} ${e.test_id}`;
    case "row_event":
      return `evt  ${e.session_id} ${e.test_id} ${e.event.name}`;
    case "row_complete":
      return `done ${e.session_id} ${e.test_id}`;
    case "session_started":
      return `session_started ${e.session_id}`;
    case "session_ended":
      return `session_ended ${e.session_id}`;
    case "run_started":
      return `run_started ${e.run_id}`;
    case "run_canceled":
      return `run_canceled (${e.rows_completed}/${e.rows_total} rows)`;
    case "run_complete":
      return `run_complete`;
    case "run_error":
      return `run_error ${e.message}`;
    default:
      return JSON.stringify(e);
  }
}
