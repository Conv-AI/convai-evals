import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { RunRequest } from "@convai/evals-shared";
import { TtsService } from "./tts/TtsService.js";
import { RunCoordinator } from "./orchestrator/RunCoordinator.js";
import type { WorkerHandle } from "./orchestrator/WorkerHandle.js";
import { judge } from "./judge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const CACHE_DIR = process.env.TTS_CACHE_DIR
  ? path.resolve(process.env.TTS_CACHE_DIR)
  : path.resolve(__dirname, "../../cache/tts");
const WORKER_STATIC_DIR = existsSync(path.resolve(__dirname, "./static"))
  ? path.resolve(__dirname, "./static")
  : path.resolve(__dirname, "../src/static");

const tts = new TtsService(CACHE_DIR);
await tts.init();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "200mb" }));

// Serve the static worker bundle (built by the worker workspace into server/src/static).
app.use("/worker", express.static(WORKER_STATIC_DIR));

// Serve cached TTS WAVs to workers.
app.get("/cache/tts/:key.wav", (req, res) => {
  const key = req.params.key;
  if (!/^[a-f0-9]{64}$/.test(key)) {
    res.status(400).send("bad key");
    return;
  }
  res.sendFile(tts.wavPathFor(key));
});

// Serve diagnostics bundle JSON by absolute path (validated to stay inside diagnostics/).
app.get("/api/diagnostics/bundle", async (req, res) => {
  const rawPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!rawPath) {
    res.status(400).json({ error: "missing path" });
    return;
  }
  const resolved = path.resolve(rawPath);
  const diagBase = path.resolve(process.cwd(), "diagnostics");
  if (!resolved.startsWith(diagBase + path.sep) && resolved !== diagBase) {
    res.status(403).json({ error: "path outside diagnostics dir" });
    return;
  }
  try {
    res.sendFile(resolved);
  } catch {
    res.status(404).json({ error: "bundle not found" });
  }
});

// Standalone judge endpoint (used by the runner; also exposed for ad-hoc grading).
app.post("/api/judge", async (req, res) => {
  try {
    const result = await judge(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const server = createServer(app);

// --- WebSocket plumbing ---
//
// Two WS roles:
// 1. /ws/control — a single per-run control socket from the UI; receives all run-level events
//    and the final report.
// 2. /ws/worker?session=<id>&run=<id> — one per Playwright worker page; orchestrator routes
//    it to the correct WorkerHandle via the workerSocketHandlers registry.

const wss = new WebSocketServer({ noServer: true });

let pendingControlWs: WebSocket | null = null;

interface WorkerSocketRegistry {
  [key: string]: (ws: WebSocket) => void;
}
const workerSocketHandlers: WorkerSocketRegistry = {};

function workerKey(sessionId: string, runId: string): string {
  return `${runId}:${sessionId}`;
}

const coordinator = new RunCoordinator({
  tts,
  workerPageUrl: `http://localhost:${PORT}/worker/worker.html`,
  orchestratorWsUrl: `ws://localhost:${PORT}/ws/worker`,
  ttsCacheServePath: (key) => `http://localhost:${PORT}/cache/tts/${key}.wav`,
  registerWorkerSocketHandler: (sessionId, runId, handler) => {
    workerSocketHandlers[workerKey(sessionId, runId)] = handler;
  },
  unregisterWorkerSocketHandler: (sessionId, runId) => {
    delete workerSocketHandlers[workerKey(sessionId, runId)];
  },
});

interface ActiveRun {
  abort: AbortController;
  handles: WorkerHandle[];
  controlWs: WebSocket | null;
}
const activeRuns = new Map<string, ActiveRun>();

app.post("/api/run", async (req, res) => {
  const body = req.body as RunRequest;
  if (!body?.config || !body?.rows) {
    res.status(400).json({ error: "missing config or rows" });
    return;
  }
  // The control socket connects right before /api/run is invoked.
  const controlWs = pendingControlWs;
  pendingControlWs = null;
  const abort = new AbortController();
  let runId: string | null = null;
  const entry: ActiveRun = { abort, handles: [], controlWs };
  try {
    const report = await coordinator.run(body, controlWs, {
      signal: abort.signal,
      onRunId: (id) => {
        runId = id;
        activeRuns.set(id, entry);
      },
      registerHandle: (h) => entry.handles.push(h),
    });
    res.json(report);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[run] failed:", message);
    if (controlWs && controlWs.readyState === controlWs.OPEN) {
      controlWs.send(JSON.stringify({ type: "run_error", message }));
    }
    res.status(500).json({ error: message });
  } finally {
    if (runId) activeRuns.delete(runId);
    if (controlWs && controlWs.readyState === controlWs.OPEN) controlWs.close();
  }
});

app.post("/api/run/:runId/cancel", async (req, res) => {
  const runId = req.params.runId;
  const entry = activeRuns.get(runId);
  if (!entry) {
    res.status(404).json({ error: "run not found or already completed" });
    return;
  }
  entry.abort.abort();
  res.status(202).json({ status: "canceling" });
  // Tear down handles in the background; the /api/run handler is still awaiting the coordinator.
  Promise.all(entry.handles.map((h) => h.cancel())).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[run] cancel teardown error:", e);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws/control") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingControlWs = ws;
      ws.on("close", () => {
        if (pendingControlWs === ws) pendingControlWs = null;
      });
    });
    return;
  }
  if (url.pathname === "/ws/worker") {
    const session = url.searchParams.get("session");
    const run = url.searchParams.get("run");
    if (!session || !run) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handler = workerSocketHandlers[workerKey(session, run)];
      if (!handler) {
        ws.close(1011, "no handler for session");
        return;
      }
      handler(ws);
    });
    return;
  }
  socket.destroy();
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[convai-evals] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[convai-evals] TTS cache: ${CACHE_DIR}`);
});
