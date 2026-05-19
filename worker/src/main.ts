// Worker entry. Order matters: install the fake getUserMedia + the /connect response
// interceptor BEFORE the SDK loads.

import { MicSink } from "./MicSink.js";
import { EventStream } from "./EventStream.js";
import { SdkBridge } from "./SdkBridge.js";
import { Scheduler } from "./Scheduler.js";
import { installConnectIntercept } from "./connectIntercept.js";
import type { WsOrchestratorToWorker } from "@convai/evals-shared";

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session") ?? "unknown";
const wsUrl = params.get("ws");

const root = document.getElementById("root");
if (root) root.textContent = `worker ready for session ${sessionId}`;

if (!wsUrl) {
  throw new Error("worker missing ?ws=... in URL");
}

// 1) Install synthetic mic + /connect response interceptor immediately.
const mic = new MicSink();
mic.installGetUserMediaOverride();
installConnectIntercept();

// 2) Connect WS, then await start_session command.
const events = new EventStream(wsUrl);
events.send({ type: "worker_ready", session_id: sessionId });

let activeScheduler: Scheduler | null = null;
let activeSdk: SdkBridge | null = null;

events.onMessage(async (raw: unknown) => {
  const msg = raw as WsOrchestratorToWorker;
  if (msg.type === "stop_session") {
    activeScheduler?.abort();
    try {
      await activeSdk?.disconnect();
    } catch {
      // ignore
    }
    events.close();
    return;
  }
  if (msg.type !== "start_session") return;
  try {
    const sdk = new SdkBridge(msg.config, sessionId, msg.run_id);
    activeSdk = sdk;
    await sdk.connect();
    // Push backend identifiers up to the orchestrator before bot_ready so all observations
    // (including those created from the start_session row list) get stamped before any row
    // events arrive.
    const ids = sdk.getBackendIds();
    events.send({
      type: "backend_ids",
      session_id: sessionId,
      backend: {
        session_id: ids.session_id,
        character_session_id: ids.character_session_id,
        character_id: ids.character_id,
      },
    });
    await sdk.waitForBotReady();
    events.send({ type: "bot_ready", session_id: sessionId, ts: performance.now() });

    const scheduler = new Scheduler({
      rows: msg.rows,
      voiceWavUrls: msg.voice_wav_urls,
      config: msg.config,
      mic,
      sdk,
      events,
      sessionId,
      runId: msg.run_id,
    });
    activeScheduler = scheduler;
    await scheduler.preloadVoiceBuffers();
    await scheduler.run();

    await sdk.disconnect();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    events.send({ type: "worker_error", session_id: sessionId, message });
  }
});
