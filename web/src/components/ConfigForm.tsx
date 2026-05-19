import { useEffect, useState } from "react";
import type { EndpointKey, RunConfig, TtsProvider } from "@convai/evals-shared";
import { fetchEndpoints } from "../api/orchestrator.js";

interface Props {
  sessionIds: string[];
  defaultConcurrency: number;
  disabled: boolean;
  onStart: (config: RunConfig) => void;
}

export function ConfigForm({ sessionIds, defaultConcurrency, disabled, onStart }: Props): JSX.Element {
  const [endpoint, setEndpoint] = useState<EndpointKey>("prod");
  const [endpoints, setEndpoints] = useState<Record<EndpointKey, string>>({
    prod: "",
    preview: "",
    staging: "",
  });
  const [characterId, setCharacterId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<string[]>(sessionIds);
  const [concurrency, setConcurrency] = useState(defaultConcurrency);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [slaVoiceAnim, setSlaVoiceAnim] = useState(3000);
  const [slaTextOut, setSlaTextOut] = useState(1200);
  const [judgeEnabled, setJudgeEnabled] = useState(false);
  const [judgeEveryNth, setJudgeEveryNth] = useState(10);
  const [judgeApiKey, setJudgeApiKey] = useState("");
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("local");
  const [ttsVoiceId, setTtsVoiceId] = useState("Samantha");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsEndpoint, setTtsEndpoint] = useState("");

  useEffect(() => {
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
  }, []);

  useEffect(() => {
    setSelectedSessions(sessionIds);
    setConcurrency(Math.min(defaultConcurrency, Math.max(1, sessionIds.length)));
  }, [sessionIds, defaultConcurrency]);

  const endpointUrl = endpoints[endpoint] ?? "";
  const canStart =
    !disabled &&
    endpointUrl.length > 0 &&
    characterId.length > 0 &&
    apiKey.length > 0 &&
    selectedSessions.length > 0;

  return (
    <div className="card">
      <h2>Run config</h2>

      <div className="form-section">
        <h3>Convai endpoint</h3>
        <label>Environment</label>
        <select value={endpoint} onChange={(e) => setEndpoint(e.target.value as EndpointKey)}>
          <option value="prod">Prod — {endpoints.prod || "(unset)"}</option>
          <option value="preview">Preview — {endpoints.preview || "(unset)"}</option>
          <option value="staging">Staging — {endpoints.staging || "(unset)"}</option>
        </select>
        {!endpointUrl && (
          <p className="error-text small">
            No URL configured for {endpoint}. Set CONVAI_ENDPOINT_{endpoint.toUpperCase()} in
            server/.env
          </p>
        )}
        <label>Character ID</label>
        <input value={characterId} onChange={(e) => setCharacterId(e.target.value)} />
        <label>Convai API key</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>

      <div className="form-section">
        <h3>Sessions</h3>
        <label>
          Selected ({selectedSessions.length}/{sessionIds.length})
        </label>
        <div
          style={{
            maxHeight: 140,
            overflowY: "auto",
            border: "1px solid var(--border-strong)",
            padding: 8,
            borderRadius: 6,
          }}
        >
          {sessionIds.map((s) => (
            <label key={s} style={{ display: "block", fontWeight: "normal", margin: "2px 0" }}>
              <input
                type="checkbox"
                checked={selectedSessions.includes(s)}
                onChange={(e) => {
                  setSelectedSessions((prev) =>
                    e.target.checked ? [...prev, s] : prev.filter((x) => x !== s),
                  );
                }}
              />
              <code>{s}</code>
            </label>
          ))}
        </div>
        <label>Concurrency ({concurrency})</label>
        <input
          type="range"
          min={1}
          max={Math.min(8, Math.max(1, selectedSessions.length))}
          value={concurrency}
          onChange={(e) => setConcurrency(parseInt(e.target.value, 10))}
        />
        <label>Speed multiplier</label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={speedMultiplier}
          onChange={(e) => setSpeedMultiplier(parseFloat(e.target.value) || 1)}
        />
      </div>

      <div className="form-section">
        <h3>Latency SLA (p95)</h3>
        <div className="row-grid">
          <div>
            <label>voice/text → voice+anim (ms)</label>
            <input
              type="number"
              value={slaVoiceAnim}
              onChange={(e) => setSlaVoiceAnim(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          <div>
            <label>text-in → text-out (ms)</label>
            <input
              type="number"
              value={slaTextOut}
              onChange={(e) => setSlaTextOut(parseInt(e.target.value, 10) || 0)}
            />
          </div>
        </div>
      </div>

      <div className="form-section">
        <h3>TTS for Voice In rows</h3>
        <p className="muted small">
          Voice In rows are synthesized to audio and streamed through a synthetic microphone in
          headless Chromium, so the SDK's VAD and STT see speech exactly like a player talking
          in-game. Default <code>Local</code> uses your OS's built-in TTS — zero setup.
        </p>
        <div className="row-grid">
          <div>
            <label>Provider</label>
            <select
              value={ttsProvider}
              onChange={(e) => setTtsProvider(e.target.value as TtsProvider)}
            >
              <option value="local">Local (free, no key)</option>
              <option value="google">Google</option>
            </select>
          </div>
          <div>
            <label>Voice ID</label>
            <input value={ttsVoiceId} onChange={(e) => setTtsVoiceId(e.target.value)} />
          </div>
        </div>
        {ttsProvider !== "local" && (
          <>
            <label>API key</label>
            <input
              type="password"
              value={ttsApiKey}
              onChange={(e) => setTtsApiKey(e.target.value)}
              placeholder={ttsApiKeyPlaceholder(ttsProvider)}
            />
            <label>Endpoint (optional)</label>
            <input
              value={ttsEndpoint}
              onChange={(e) => setTtsEndpoint(e.target.value)}
              placeholder={ttsEndpointPlaceholder(ttsProvider)}
            />
          </>
        )}
      </div>

      <div className="form-section">
        <h3>Response quality (optional)</h3>
        <label>
          <input
            type="checkbox"
            checked={judgeEnabled}
            onChange={(e) => setJudgeEnabled(e.target.checked)}
          />
          Run semantic judge
        </label>
        {judgeEnabled && (
          <>
            <label>Judge every Nth respond row</label>
            <input
              type="number"
              min={1}
              value={judgeEveryNth}
              onChange={(e) => setJudgeEveryNth(parseInt(e.target.value, 10) || 1)}
            />
            <label>Judge API key</label>
            <input
              type="password"
              value={judgeApiKey}
              onChange={(e) => setJudgeApiKey(e.target.value)}
              placeholder="falls back to CONVAI_EVALS_JUDGE_API_KEY if blank"
            />
          </>
        )}
      </div>

      <button
        type="button"
        className="primary"
        disabled={!canStart}
        style={{ marginTop: 16, width: "100%" }}
        onClick={() => {
          onStart({
            endpoint,
            endpointUrl,
            characterId,
            apiKey,
            sessionIds: selectedSessions,
            concurrency,
            speedMultiplier,
            slaVoiceAnimMs: slaVoiceAnim,
            slaTextOutMs: slaTextOut,
            judgeEnabled,
            judgeEveryNth,
            judgeApiKey: judgeApiKey || undefined,
            ttsProvider,
            ttsVoiceId,
            ttsApiKey: ttsApiKey || undefined,
            ttsEndpoint: ttsEndpoint || undefined,
          });
        }}
      >
        Run
      </button>
    </div>
  );
}

function ttsApiKeyPlaceholder(provider: TtsProvider): string {
  switch (provider) {
    case "local":
      return "not needed (uses your OS's built-in TTS — say on Mac, espeak on Linux)";
    case "google":
      return "Google TTS API key (or CONVAI_EVALS_TTS_API_KEY on the server)";
  }
}

function ttsEndpointPlaceholder(provider: TtsProvider): string {
  switch (provider) {
    case "local":
      return "not needed";
    case "google":
      return "https://texttospeech.googleapis.com (default)";
  }
}
