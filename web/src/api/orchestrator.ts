import type { ReportPayload, RunRequest, WsServerToClient } from "@convai/evals-shared";

export async function fetchEndpoints(): Promise<{ prod: string; preview: string; staging: string }> {
  const resp = await fetch("/api/endpoints");
  if (!resp.ok) throw new Error("failed to load endpoints");
  return resp.json();
}

export interface RunHandle {
  controlWs: WebSocket;
  donePromise: Promise<ReportPayload>;
  cancel(): Promise<void>;
}

export function startRun(req: RunRequest, onEvent: (msg: WsServerToClient) => void): RunHandle {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const controlWs = new WebSocket(`${proto}//${window.location.host}/ws/control`);
  let resolveDone!: (r: ReportPayload) => void;
  let rejectDone!: (e: Error) => void;
  const donePromise = new Promise<ReportPayload>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // Captured from the first server-side run_started event so cancel() can address the right run.
  let runId: string | null = null;
  controlWs.addEventListener("open", async () => {
    try {
      const resp = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        rejectDone(new Error(txt));
        return;
      }
      const report = (await resp.json()) as ReportPayload;
      resolveDone(report);
    } catch (e) {
      rejectDone(e instanceof Error ? e : new Error(String(e)));
    }
  });
  controlWs.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as WsServerToClient;
      if (msg.type === "run_started") runId = msg.run_id;
      onEvent(msg);
    } catch {
      // ignore
    }
  });
  controlWs.addEventListener("error", () => {
    // network-level error; the fetch promise will surface the failure
  });
  const cancel = async () => {
    if (!runId) return;
    try {
      await fetch(`/api/run/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    } catch {
      // Cancel is best-effort; the run will eventually finish or time out.
    }
  };
  return { controlWs, donePromise, cancel };
}
