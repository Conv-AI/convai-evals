import "dotenv/config";
import { existsSync, promises as fs } from "node:fs";
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

function ensureHttps(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}
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

// Endpoint URL config surfaced to the UI so it doesn't need to bundle these.
// Built-in defaults match the Convai realtime API hosts; env vars override.
const DEFAULT_ENDPOINTS = {
  prod: "https://realtime-api.convai.com",
  preview: "https://realtime-api-preview.convai.com",
  staging: "https://realtime-api-stg.convai.com",
};
app.get("/api/endpoints", (_req, res) => {
  res.json({
    prod: ensureHttps(process.env.CONVAI_ENDPOINT_PROD || DEFAULT_ENDPOINTS.prod),
    preview: ensureHttps(process.env.CONVAI_ENDPOINT_PREVIEW || DEFAULT_ENDPOINTS.preview),
    staging: ensureHttps(process.env.CONVAI_ENDPOINT_STAGING || DEFAULT_ENDPOINTS.staging),
  });
});

// Local visual lipsync convenience secrets. This is intentionally a repo-root
// untracked file for local testing only, not a general credential store.
app.get("/api/visual-lipsync/secrets", async (_req, res) => {
  try {
    const secretsPath = findVisualLipsyncSecretsPath();
    if (!secretsPath) {
      res.json({ apiKey: "", characterId: "", source: "" });
      return;
    }
    const text = await fs.readFile(secretsPath, "utf8");
    const parsed = parseVisualLipsyncSecrets(text);
    res.json({
      apiKey: parsed["api-key"] ?? "",
      characterId: parsed["character-id"] ?? "",
      source: "visual_lipsync_testing_secrets",
    });
  } catch {
    res.json({ apiKey: "", characterId: "", source: "" });
  }
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

app.post("/api/visual-lipsync/report", async (req, res) => {
  try {
    const report = req.body as { runId?: string };
    const runId = sanitizeReportId(report?.runId ?? "visual-lipsync");
    const targetDir = path.resolve(__dirname, "../..", "reports");
    await fs.mkdir(targetDir, { recursive: true });
    const content = `${JSON.stringify(req.body, null, 2)}\n`;
    const runPath = path.join(targetDir, `visual-lipsync-${runId}.json`);
    const latestPath = path.join(targetDir, "visual-lipsync-latest.json");
    await fs.writeFile(runPath, content, "utf8");
    await fs.writeFile(latestPath, content, "utf8");
    res.json({ ok: true, path: runPath });
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

function parseVisualLipsyncSecrets(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (key === "api-key" || key === "character-id") result[key] = value;
  }
  return result;
}

function findVisualLipsyncSecretsPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "visual_lipsync_testing_secrets"),
    path.resolve(process.cwd(), "../visual_lipsync_testing_secrets"),
    path.resolve(__dirname, "../../visual_lipsync_testing_secrets"),
    path.resolve(__dirname, "../../../visual_lipsync_testing_secrets"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sanitizeReportId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "visual-lipsync";
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
