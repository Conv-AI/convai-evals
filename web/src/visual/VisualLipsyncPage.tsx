import { useEffect, useMemo, useRef, useState } from "react";
import type { EndpointKey } from "@convai/evals-shared";
import { fetchEndpoints } from "../api/orchestrator.js";
import { AudioProbe } from "./AudioProbe.js";
import { ConvaiVisualSession } from "./ConvaiVisualSession.js";
import { DEFAULT_VISUAL_PROMPTS, parsePromptLines, promptsToText } from "./defaultPrompts.js";
import { LowPolyFaceRenderer } from "./LowPolyFaceRenderer.js";
import { TurnRunner } from "./TurnRunner.js";
import { computeAggregateVisualMetrics } from "./visualMetrics.js";
import { saveVisualReport, saveVisualReportLocal } from "./visualReport.js";
import type { AggregateVisualMetrics, VisualReportPayload, VisualTurnCapture, VisualTurnResult } from "./visualTypes.js";

interface Props {
  onBack: () => void;
}

interface VisualSecrets {
  apiKey: string;
  characterId: string;
  source: string;
}

export function VisualLipsyncPage({ onBack }: Props): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<LowPolyFaceRenderer | null>(null);
  const audioProbeRef = useRef<AudioProbe | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(`visual-${Date.now()}`);
  const resultsRef = useRef<VisualTurnResult[]>([]);
  const currentTurnRef = useRef<VisualTurnCapture | null>(null);
  const lastLocalSaveRef = useRef(0);
  const [endpoint, setEndpoint] = useState<EndpointKey>("preview");
  const [endpoints, setEndpoints] = useState<Record<EndpointKey, string>>({ prod: "", preview: "", staging: "" });
  const [characterId, setCharacterId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [secrets, setSecrets] = useState<VisualSecrets>({ apiKey: "", characterId: "", source: "" });
  const [promptText, setPromptText] = useState(promptsToText(DEFAULT_VISUAL_PROMPTS));
  const [requestCount, setRequestCount] = useState<number | "">(20);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [muteAudio, setMuteAudio] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState<VisualTurnCapture | null>(null);
  const [results, setResults] = useState<VisualTurnResult[]>([]);

  useEffect(() => {
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
    fetchVisualSecrets().then(setSecrets).catch(() => undefined);
  }, []);

  useEffect(() => {
    const renderer = new LowPolyFaceRenderer();
    rendererRef.current = renderer;
    if (mountRef.current) renderer.mount(mountRef.current);
    return () => {
      abortRef.current?.abort();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    audioProbeRef.current?.setMuted(muteAudio);
  }, [muteAudio]);

  const prompts = useMemo(() => parsePromptLines(promptText), [promptText]);
  const selectedPrompts = useMemo(() => prompts.slice(0, Math.max(1, Math.min(20, requestCount || 1))), [prompts, requestCount]);
  const endpointUrl = endpoints[endpoint] ?? "";
  const effectiveCharacterId = characterId.trim() || secrets.characterId;
  const effectiveApiKey = apiKey.trim() || secrets.apiKey;
  const hasSecretFallback = Boolean(secrets.apiKey || secrets.characterId);
  const aggregate = useMemo<AggregateVisualMetrics | null>(
    () => (results.length ? computeAggregateVisualMetrics(results) : null),
    [results],
  );
  const canRun = !running && endpointUrl && effectiveCharacterId && effectiveApiKey && selectedPrompts.length > 0;

  const start = async () => {
    const renderer = rendererRef.current;
    if (!renderer || !canRun) return;
    setRunning(true);
    runIdRef.current = `visual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    setError(null);
    resultsRef.current = [];
    currentTurnRef.current = null;
    setResults([]);
    setCurrentTurn(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const audioProbe = new AudioProbe();
    audioProbe.setMuted(muteAudio);
    audioProbeRef.current = audioProbe;
    const session = new ConvaiVisualSession({
      endpoint,
      endpointUrl,
      characterId: effectiveCharacterId,
      apiKey: effectiveApiKey,
    });
    try {
      setStatus("Connecting to Convai");
      await session.connect();
      audioProbe.attachRoom(session.getRoom());
      setStatus("Waiting for bot ready");
      await session.waitForBotReady();
      const runner = new TurnRunner({
        session,
        renderer,
        audioProbe,
        prompts: selectedPrompts,
        timeoutMs,
        signal: abort.signal,
        onTurnStart: (turnIndex, prompt) => {
          setStatus(`Turn ${turnIndex}/${selectedPrompts.length}: ${prompt}`);
        },
        onTurnUpdate: (capture) => {
          currentTurnRef.current = capture;
          setCurrentTurn(capture);
          const now = Date.now();
          if (now - lastLocalSaveRef.current > 1000) {
            lastLocalSaveRef.current = now;
            saveVisualReportLocal(buildReport("running", resultsRef.current, capture));
          }
        },
        onTurnComplete: (result) => {
          const next = [...resultsRef.current, result];
          resultsRef.current = next;
          currentTurnRef.current = null;
          void saveVisualReport(buildReport("running", next, null)).catch((saveErr) => {
            setError(saveErr instanceof Error ? saveErr.message : String(saveErr));
          });
          setResults(next);
          setCurrentTurn(null);
        },
      });
      const finalResults = await runner.run();
      resultsRef.current = finalResults;
      setResults(finalResults);
      await saveVisualReport(buildReport(abort.signal.aborted ? "stopped" : "complete", finalResults, null));
      setStatus(`Finished ${finalResults.length} turns`);
    } catch (e) {
      if (abort.signal.aborted) {
        await saveVisualReport(buildReport("stopped", resultsRef.current, currentTurnRef.current)).catch(() => undefined);
        setStatus("Stopped");
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        await saveVisualReport(buildReport("failed", resultsRef.current, currentTurnRef.current, message)).catch(() => undefined);
        setStatus("Failed");
      }
    } finally {
      audioProbe.detach();
      audioProbeRef.current = null;
      await session.disconnect().catch(() => undefined);
      renderer.resetMouth();
      abortRef.current = null;
      setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setStatus("Stopping");
  };

  return (
    <div className="page visual-page">
      <header className="page-header visual-header">
        <div>
          <h1>Visual Lipsync</h1>
          <p className="muted">Automated 20-turn visual verification for Convai voice and ARKit lipsync alignment.</p>
        </div>
        <div className="header-actions">
          <button className="ghost" type="button" onClick={onBack} title="Return to the standard dataset eval page.">
            Back to evals
          </button>
          {running ? (
            <button className="danger" type="button" onClick={stop} title="Stop after saving the current partial visual report.">
              Stop
            </button>
          ) : (
            <button className="primary" type="button" disabled={!canRun} onClick={start} title="Start the selected number of sequential text requests.">
              Run visual test
            </button>
          )}
        </div>
      </header>

      <section className="visual-workbench">
        <div className="visual-stage" title="Front-facing ARKit measurement face. Mouth pixels and ARKit mouth values are sampled from this view.">
          <div ref={mountRef} className="visual-canvas" title="3D ARKit lipsync test model." />
          <div className="visual-status-strip" title="Current connection or turn status.">
            <span className={running ? "pulse-dot" : "status-dot-idle"} />
            <span>{status}</span>
          </div>
        </div>

        <div className="visual-controls card">
          <h2>Config</h2>
          <div className="form-section">
            <label title="Convai realtime endpoint to test. The URL comes from the server endpoint config.">Environment</label>
            <select
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value as EndpointKey)}
              disabled={running}
              title="Choose prod, preview, or staging Convai realtime endpoint."
            >
              <option value="prod">Prod - {endpoints.prod || "(unset)"}</option>
              <option value="preview">Preview - {endpoints.preview || "(unset)"}</option>
              <option value="staging">Staging - {endpoints.staging || "(unset)"}</option>
            </select>
            {!endpointUrl && (
              <p className="error-text small">No endpoint URL configured for {endpoint}.</p>
            )}
            <label title="Convai character ID. Optional when visual_lipsync_testing_secrets provides character-id.">Character ID</label>
            <input
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              disabled={running}
              placeholder={secrets.characterId ? "optional - using visual_lipsync_testing_secrets" : ""}
              title="Optional override for character-id from visual_lipsync_testing_secrets."
            />
            <label title="Convai API key. Optional when visual_lipsync_testing_secrets provides api-key.">Convai API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={running}
              placeholder={secrets.apiKey ? "optional - using visual_lipsync_testing_secrets" : ""}
              title="Optional override for api-key from visual_lipsync_testing_secrets."
            />
            {hasSecretFallback && (
              <p className="muted small visual-secret-note">
                Character ID and API key are optional here because <code>{secrets.source}</code> was found.
                Enter values above only to override that file.
              </p>
            )}
            <label title="How many prompts from the list to send, strictly one after another.">Requests to send</label>
            <input
              type="number"
              min={1}
              max={20}
              value={requestCount}
              disabled={running}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") { setRequestCount(""); return; }
                const n = parseInt(raw, 10);
                if (!isNaN(n)) setRequestCount(Math.max(1, Math.min(20, n)));
              }}
              title="Number of sequential text requests to run, from 1 to 20."
            />
            <label title="Safety timeout only. The next request starts as soon as the prior turn completes.">Max wait per turn (ms)</label>
            <input
              type="number"
              min={5000}
              step={1000}
              value={timeoutMs}
              disabled={running}
              onChange={(e) => setTimeoutMs(parseInt(e.target.value, 10) || 30000)}
              title="Maximum safety wait per turn; this is not a sleep between responses."
            />
            <label title="Mute local playback while still analyzing the remote audio stream.">
              <input
                type="checkbox"
                checked={muteAudio}
                onChange={(e) => setMuteAudio(e.target.checked)}
                title="Toggle whether you hear bot audio. Audio is still captured for measurement."
              />
              Mute playback during test
            </label>
            <p className="muted small">
              This is only a safety cap. The next text is sent as soon as the previous response finishes, plus a 500ms quiet check.
            </p>
          </div>
          <div className="form-section">
            <h3 title="One prompt per line. The tester uses the first N lines based on Requests to send.">
              Text inputs ({selectedPrompts.length}/{prompts.length || 0})
            </h3>
            <textarea
              className="prompt-list"
              value={promptText}
              disabled={running}
              onChange={(e) => setPromptText(e.target.value)}
              spellCheck={false}
              title="Editable prompt list. One prompt per line; up to the first 20 are used."
            />
          </div>
        </div>
      </section>

      {error && (
        <section>
          <div className="card error-card">
            <h2>Visual test error</h2>
            <pre>{error}</pre>
          </div>
        </section>
      )}

      {(aggregate || currentTurn) && (
        <section>
          <div className="stat-row">
            <Stat
              label="Completed"
              value={`${aggregate?.completedTurns ?? results.length}/${selectedPrompts.length}`}
              title="Turns that have finished or produced a saved result."
            />
            <Stat
              label="Audio tracked"
              value={`${aggregate?.audioDetectedTurns ?? 0}/${results.length || selectedPrompts.length}`}
              title="Turns where the audio energy window was detected."
            />
            <Stat
              label="Mouth tracked"
              value={`${aggregate?.visualDetectedTurns ?? 0}/${results.length || selectedPrompts.length}`}
              title="Turns where visual mouth movement was detected."
            />
            <Stat
              label="Avg start delta"
              value={formatMs(aggregate?.averageOnsetDeltaMs)}
              title="Average mouth-start minus audio-start delta. Positive means the mouth started after audio."
            />
            <Stat
              label="Avg end delta"
              value={formatMs(aggregate?.averageOffsetDeltaMs)}
              title="Average mouth-end minus audio-end delta. Positive means the mouth ended after audio."
            />
            <Stat
              label="Avg sync lag"
              value={formatMs(aggregate?.averageLagMs)}
              title="Average absolute lag from the harder during-speech correlation check."
            />
          </div>
          {currentTurn && (
            <div className="card">
              <h2>Current turn</h2>
              <p>
                <strong>Turn {currentTurn.turnIndex}</strong> - {currentTurn.prompt}
              </p>
              {currentTurn.responseText && (
                <pre title="Current streamed text response captured from Convai SDK messagesChange.">
                  {currentTurn.responseText}
                </pre>
              )}
              <div className="progress-bar" aria-label="turn progress">
                <div style={{ width: `${Math.min(100, (currentTurn.durationMs / timeoutMs) * 100)}%` }} />
              </div>
            </div>
          )}
        </section>
      )}

      {results.length > 0 && (
        <section>
          <div className="card">
            <h2>Per-turn results</h2>
            <div className="table-scroll">
              <table className="data-table data-table--compact visual-result-table">
                <thead>
                  <tr>
                    <th title="Sequential turn number.">Turn</th>
                    <th title="Prompt sent to Convai and the streamed text response captured from the SDK.">Prompt / response</th>
                    <th title="Easy-to-verify timing: did mouth movement start and end with audio/speaking events?">Start/end timing</th>
                    <th title="Harder-to-verify sync while speech is active: correlation, best lag, and coarse mouth-shape signals.">During-speech sync</th>
                    <th title="Raw signal capture counts and audio analyser state.">Captured signals</th>
                    <th title="Recent raw SDK/audio/runner logs for this turn.">Logs</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={result.turnIndex}>
                      <td>{result.turnIndex}</td>
                      <td>
                        <div className="metric-label" title="Exact text prompt sent through sendUserTextMessage.">Prompt</div>
                        <div title={result.prompt}>{result.prompt}</div>
                        {result.responseText && (
                          <details>
                            <summary title="Text response captured from SDK messagesChange bot-llm-text.">response text</summary>
                            <pre>{result.responseText}</pre>
                          </details>
                        )}
                      </td>
                      <td>{renderTimingMetrics(result)}</td>
                      <td>{renderSyncMetrics(result)}</td>
                      <td>{renderSignalMetrics(result)}</td>
                      <td>
                        <details>
                          <summary title="Raw recent events for this turn, including audio source setup and SDK events.">raw logs</summary>
                          <pre>{formatDebug(result)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {results.some((r) => r.snapshots.length > 0) && (
        <section>
          <div className="snapshot-grid">
            {results.flatMap((result) =>
              result.snapshots.slice(0, 4).map((shot) => (
                <figure className="snapshot-card" key={`${result.turnIndex}-${shot.label}-${shot.tMs}`}>
                  <img src={shot.dataUrl} alt={`Turn ${result.turnIndex} ${shot.label}`} />
                  <figcaption>
                    Turn {result.turnIndex} - {shot.label} - {Math.round(shot.tMs)}ms
                  </figcaption>
                </figure>
              )),
            )}
          </div>
        </section>
      )}
    </div>
  );

  function buildReport(
    reportStatus: VisualReportPayload["status"],
    reportResults: VisualTurnResult[],
    reportCurrentTurn: VisualTurnCapture | null,
    reportError?: string,
  ): VisualReportPayload {
    return {
      runId: runIdRef.current,
      status: reportStatus,
      updatedAt: new Date().toISOString(),
      config: {
        endpoint,
        endpointUrl,
        characterId: effectiveCharacterId,
        prompts: selectedPrompts,
        timeoutMs,
        requestCount: selectedPrompts.length,
        muteAudio,
        apiKeySource: apiKey.trim() ? "manual" : "file",
        characterIdSource: characterId.trim() ? "manual" : "file",
      },
      currentTurn: reportCurrentTurn,
      results: reportResults,
      aggregate: reportResults.length ? computeAggregateVisualMetrics(reportResults) : null,
      error: reportError,
    };
  }
}

function Stat({ label, value, title }: { label: string; value: string; title: string }): JSX.Element {
  return (
    <div className="stat" title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title: string }): JSX.Element {
  return (
    <div className="metric-row" title={title}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function renderTimingMetrics(result: VisualTurnResult): JSX.Element {
  return (
    <div className="metric-stack">
      <Metric
        label="audio"
        value={formatWindow(result.metrics.audioWindow)}
        title="Detected audio activity window from the remote audio RMS envelope."
      />
      <Metric
        label="mouth"
        value={formatWindow(result.metrics.visualWindow)}
        title="Detected visible mouth activity window from ARKit mouth values and mouth-region pixels."
      />
      <Metric
        label="speaking"
        value={`${formatMs(result.speakingStartMs)} -> ${formatMs(result.speakingEndMs)}`}
        title="SDK speakingChange true/false timestamps for the bot turn."
      />
      <Metric
        label="start delta"
        value={formatMs(result.metrics.onsetDeltaMs)}
        title="Mouth start minus audio start. Positive means mouth started after audio."
      />
      <Metric
        label="end delta"
        value={formatMs(result.metrics.offsetDeltaMs)}
        title="Mouth end minus audio end. Positive means mouth continued after audio."
      />
    </div>
  );
}

function renderSyncMetrics(result: VisualTurnResult): JSX.Element {
  const rounded = result.metrics.shapeChecks.find((c) => c.name === "rounded vowels");
  const wide = result.metrics.shapeChecks.find((c) => c.name === "wide vowels");
  const closed = result.metrics.shapeChecks.find((c) => c.name === "closed consonants");
  return (
    <div className="metric-stack">
      <Metric
        label="best lag"
        value={formatMs(result.metrics.bestLagMs)}
        title="Lag that gives the strongest correlation between audio energy and visible mouth opening."
      />
      <Metric
        label="correlation"
        value={formatNumber(result.metrics.correlation)}
        title="Pearson correlation between mouth aperture and audio energy after testing small time offsets."
      />
      <Metric
        label="rounded"
        value={formatNumber(rounded?.observed)}
        title="Observed funnel/pucker strength for prompts or responses with many rounded vowel sounds."
      />
      <Metric
        label="wide"
        value={formatNumber(wide?.observed)}
        title="Observed smile/stretch strength for prompts or responses with many E/I-like sounds."
      />
      <Metric
        label="closed"
        value={formatNumber(closed?.observed)}
        title="Observed mouthClose strength for prompts or responses with M/B/P closures."
      />
    </div>
  );
}

function renderSignalMetrics(result: VisualTurnResult): JSX.Element {
  return (
    <div className="metric-stack">
      <Metric
        label="blend frames"
        value={`${result.playedBlendshapeFrameCount}/${result.blendshapeFrameCount}`}
        title="Played blendshape frames over received blendshape frames."
      />
      <Metric
        label="chunks"
        value={String(result.blendshapeChunkCount)}
        title="Number of Convai blendshape chunks received for this turn."
      />
      <Metric
        label="audio peak"
        value={formatNumber(result.audioDebug.maxLevel)}
        title="Maximum audio RMS level measured by the analyser for this turn."
      />
      <Metric
        label="analyser"
        value={result.audioDebug.analyserReady ? result.audioDebug.audioContextState : "missing"}
        title="Whether the Web Audio analyser was connected and its AudioContext state."
      />
      <Metric
        label="mute"
        value={result.audioDebug.muted ? "on" : "off"}
        title="Whether local playback was muted. Muting should not stop analysis."
      />
    </div>
  );
}

function formatMs(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}ms` : "-";
}

function formatWindow(value: { startMs: number; endMs: number } | null | undefined): string {
  return value ? `${formatMs(value.startMs)} -> ${formatMs(value.endMs)}` : "-";
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

function formatDebug(result: VisualTurnResult): string {
  return JSON.stringify(
    {
      audioDebug: result.audioDebug,
      responseChars: result.responseText.length,
      turnStats: result.turnStats,
      blendshapeFrames: result.blendshapeFrameCount,
      playedBlendshapeFrames: result.playedBlendshapeFrameCount,
      lastEvents: result.debugEvents.slice(-80).map((event) => ({
        tMs: Math.round(event.tMs),
        name: event.name,
        data: event.data,
      })),
    },
    null,
    2,
  );
}

async function fetchVisualSecrets(): Promise<VisualSecrets> {
  const resp = await fetch("/api/visual-lipsync/secrets");
  if (!resp.ok) return { apiKey: "", characterId: "", source: "" };
  const raw = (await resp.json()) as Partial<VisualSecrets>;
  return {
    apiKey: raw.apiKey ?? "",
    characterId: raw.characterId ?? "",
    source: raw.source ?? "",
  };
}
