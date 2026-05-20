import { useEffect, useRef, useState } from "react";
import type { RunHandle } from "./api/orchestrator.js";
import type { ReportPayload, RunConfig, TestRow, WsServerToClient } from "@convai/evals-shared";
import { CsvUpload } from "./components/CsvUpload.js";
import { SchemaDoc } from "./components/SchemaDoc.js";
import { ConfigForm } from "./components/ConfigForm.js";
import { RunDashboard } from "./components/RunDashboard.js";
import { ReportView } from "./components/ReportView.js";
import { DatasetDetail } from "./components/DatasetDetail.js";
import { CsvParseError, parseCsvFile, parseCsvText, type CsvParseResult } from "./csv/CsvParser.js";
import { startRun } from "./api/orchestrator.js";
import { VisualLipsyncPage } from "./visual/VisualLipsyncPage.js";

interface RunState {
  events: WsServerToClient[];
  ttsProgress: { done: number; total: number } | null;
  ttsComplete: boolean;
  perSession: Record<string, { dispatched: number; complete: number }>;
  totalRows: number;
  running: boolean;
  error: string | null;
  startedAt: number | null;
  expectedTotalMs: number | null;
}

const initialRunState: RunState = {
  events: [],
  ttsProgress: null,
  ttsComplete: false,
  perSession: {},
  totalRows: 0,
  running: false,
  error: null,
  startedAt: null,
  expectedTotalMs: null,
};

interface DatasetState {
  result: CsvParseResult;
  filename: string;
  isSample: boolean;
}

export function App(): JSX.Element {
  const [view, setView] = useState<"evals" | "visual">(() =>
    window.location.hash === "#visual-lipsync" ? "visual" : "evals",
  );
  const [dataset, setDataset] = useState<DatasetState | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>(initialRunState);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reportInputRef = useRef<HTMLInputElement>(null);
  const runHandleRef = useRef<RunHandle | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      setView(window.location.hash === "#visual-lipsync" ? "visual" : "evals");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openVisual = () => {
    window.location.hash = "visual-lipsync";
    setView("visual");
  };

  const openEvals = () => {
    if (window.location.hash) {
      history.pushState("", document.title, window.location.pathname + window.location.search);
    }
    setView("evals");
  };

  if (view === "visual") {
    return <VisualLipsyncPage onBack={openEvals} />;
  }

  const handleStart = async (config: RunConfig) => {
    if (!dataset) return;
    setReport(null);
    const selectedRows = dataset.result.rows.filter((r) => config.sessionIds.includes(r.session_id));
    const expectedTotalMs = estimateRunDuration(selectedRows, config);
    setRun({
      ...initialRunState,
      running: true,
      totalRows: selectedRows.length,
      startedAt: Date.now(),
      expectedTotalMs,
    });
    const handle = startRun(
      { config, rows: dataset.result.rows },
      (msg) => {
        setRun((prev) => applyEvent(prev, msg));
      },
    );
    runHandleRef.current = handle;
    try {
      const r = await handle.donePromise;
      setReport(r);
    } catch (e) {
      setRun((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRun((prev) => ({ ...prev, running: false }));
      runHandleRef.current = null;
      handle.controlWs.close();
    }
  };

  const handleStop = () => {
    runHandleRef.current?.cancel();
  };

  const loadSample = async () => {
    setUploadError(null);
    try {
      const resp = await fetch("/sample-dataset.csv");
      const text = await resp.text();
      const result = parseCsvText(text);
      setDataset({ result, filename: "sample-dataset.csv", isSample: true });
      setReport(null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    }
  };

  const triggerUpload = () => {
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  const triggerReportLoad = () => {
    if (!reportInputRef.current) return;
    reportInputRef.current.value = "";
    reportInputRef.current.click();
  };

  const handleReportFileChosen: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as ReportPayload;
      setReport(payload);
    } catch (err) {
      setRun((prev) => ({ ...prev, error: `Failed to load report: ${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      if (reportInputRef.current) reportInputRef.current.value = "";
    }
  };

  const handleFileChosen: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    try {
      const result = await parseCsvFile(file);
      setDataset({ result, filename: file.name, isSample: false });
      setReport(null);
    } catch (err) {
      if (err instanceof CsvParseError) {
        setUploadError(`${err.message}${err.details.length ? `\n${err.details.join("\n")}` : ""}`);
      } else {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="page">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleFileChosen}
      />
      <input
        ref={reportInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={handleReportFileChosen}
      />
      <header className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Convai Evals</h1>
          <p className="muted">Agentic evaluation toolkit for Convai Character AI infrastructure.</p>
        </div>
        <div className="header-actions">
          <button className="primary-outline" style={{ marginTop: 8, flexShrink: 0 }} onClick={openVisual}>
            Visual Lipsync
          </button>
          <button className="primary-outline" style={{ marginTop: 8, flexShrink: 0 }} onClick={triggerReportLoad}>
            Load saved report
          </button>
        </div>
      </header>

      <section>
        <StepHeader number={1} title="Load dataset" />
        <CsvUpload
          hasDataset={dataset !== null}
          onTriggerUpload={triggerUpload}
          onLoadSample={loadSample}
          error={uploadError}
        />
        {!dataset && <SchemaDoc onLoadSample={loadSample} />}
        {dataset && (
          <DatasetDetail
            filename={dataset.filename}
            isSample={dataset.isSample}
            dataset={dataset.result}
            onUploadDifferent={triggerUpload}
            onResetToSample={loadSample}
          />
        )}
      </section>

      {dataset && (
        <section>
          <StepHeader number={2} title="Configure run" />
          <ConfigForm
            sessionIds={dataset.result.session_ids}
            defaultConcurrency={Math.min(8, dataset.result.session_ids.length)}
            disabled={run.running}
            onStart={handleStart}
          />
        </section>
      )}

      {run.running && (
        <section>
          <StepHeader number={3} title="Run in progress" />
          <RunDashboard
            events={run.events}
            ttsProgress={run.ttsProgress}
            ttsComplete={run.ttsComplete}
            perSession={run.perSession}
            totalRows={run.totalRows}
            startedAt={run.startedAt}
            expectedTotalMs={run.expectedTotalMs}
            onStop={handleStop}
          />
        </section>
      )}

      {run.error && (
        <section>
          <div className="card error-card">
            <h2>Run error</h2>
            <pre>{run.error}</pre>
          </div>
        </section>
      )}

      {report && (
        <section>
          <StepHeader number={3} title="Report" />
          <ReportView report={report} />
        </section>
      )}
    </div>
  );
}

function StepHeader({ number, title }: { number: number; title: string }): JSX.Element {
  return (
    <div className="step-header">
      <span className="step-number">{number}</span>
      <h2 className="step-title">{title}</h2>
    </div>
  );
}

function applyEvent(prev: RunState, msg: WsServerToClient): RunState {
  const events = [...prev.events, msg];
  if (msg.type === "tts_progress") {
    return { ...prev, events, ttsProgress: { done: msg.done, total: msg.total } };
  }
  if (msg.type === "tts_complete") {
    return { ...prev, events, ttsComplete: true };
  }
  if (msg.type === "row_dispatched" || msg.type === "row_complete") {
    const ps = { ...prev.perSession };
    // Clone the slot before mutating; otherwise StrictMode's double-invoked
    // updater (and any future replay) would increment the same object twice.
    const existing = ps[msg.session_id] ?? { dispatched: 0, complete: 0 };
    const slot = { ...existing };
    if (msg.type === "row_dispatched") slot.dispatched += 1;
    if (msg.type === "row_complete") slot.complete += 1;
    ps[msg.session_id] = slot;
    return { ...prev, events, perSession: ps };
  }
  if (msg.type === "run_error") {
    return { ...prev, events, error: msg.message };
  }
  return { ...prev, events };
}

/**
 * Predict wall-clock duration of a run before starting it. Used to drive the ETA
 * countdown in RunDashboard. Two phases:
 *
 *   1. TTS pre-generation — proportional to the number of unique Voice In utterances,
 *      with a per-call cost that depends on provider (local is fastest, cloud slower).
 *      Synthesis runs at concurrency 10 server-side.
 *
 *   2. Session execution — each session takes (max_offset - min_offset) / speed seconds
 *      of scheduled dispatch + a trailing response window. With concurrency C, sessions
 *      are batched LPT-style (longest-processing-time-first), and each batch costs the
 *      length of its longest session.
 */
function estimateRunDuration(rows: TestRow[], config: RunConfig): number {
  if (rows.length === 0) return 0;

  // Phase 1: TTS pre-gen
  const voiceTexts = new Set<string>();
  for (const r of rows) {
    if (r.input_kind === "Voice In") {
      const text = (r.input_text ?? "").trim();
      if (text) voiceTexts.add(text);
    }
  }
  const perTtsMs: Record<string, number> = {
    local: 600, // macOS `say` + afconvert
    google: 1500,
  };
  const ttsCost = perTtsMs[config.ttsProvider] ?? 1500;
  const ttsConcurrency = 10;
  const ttsMs = Math.ceil(voiceTexts.size / ttsConcurrency) * ttsCost;

  // Phase 2: Session execution. Per session: timestamp span / speed + trailing window.
  const sessions = new Map<string, TestRow[]>();
  for (const r of rows) {
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
    sessions.get(r.session_id)!.push(r);
  }
  const speed = Math.max(0.01, config.speedMultiplier);
  const perSessionMs: number[] = [];
  for (const [, sessionRows] of sessions) {
    const offsets = sessionRows.map((r) => r.timestamp_offset_s);
    const span = Math.max(...offsets) - Math.min(...offsets);
    const lastHasResponse = sessionRows[sessionRows.length - 1]?.expected_response_behavior !== "no_call";
    const trailingMs = lastHasResponse ? 8000 : 1500;
    perSessionMs.push((span * 1000) / speed + trailingMs);
  }
  // LPT batching: sort desc, take every Cth (the longest session per batch dominates).
  perSessionMs.sort((a, b) => b - a);
  const C = Math.max(1, config.concurrency);
  let executionMs = 0;
  for (let i = 0; i < perSessionMs.length; i += C) {
    executionMs += perSessionMs[i]!;
  }

  return ttsMs + executionMs;
}
