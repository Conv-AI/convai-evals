import type { ReportPayload, RunRequest, WsServerToClient } from "@convai/evals-shared";

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
  let settled = false;
  const settleResolve = (r: ReportPayload) => {
    if (!settled) {
      settled = true;
      resolveDone(r);
    }
  };
  const settleReject = (e: Error) => {
    if (!settled) {
      settled = true;
      rejectDone(e);
    }
  };
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
        settleReject(new Error(await resp.text()));
        return;
      }
      const report = (await resp.json()) as ReportPayload;
      settleResolve(report);
    } catch {
      // The POST /api/run request is held open for the entire run, so the browser, OS, or
      // a proxy can drop it on long runs. Do NOT fail here — the report is delivered by the
      // run_complete event below over the (still-open) control socket.
    }
  });
  controlWs.addEventListener("message", (ev) => {
    let msg: WsServerToClient;
    try {
      msg = JSON.parse(ev.data as string) as WsServerToClient;
    } catch {
      return;
    }
    if (msg.type === "run_started") runId = msg.run_id;
    else if (msg.type === "run_complete") settleResolve(msg.report);
    else if (msg.type === "run_error") settleReject(new Error(msg.message));
    onEvent(msg);
  });
  controlWs.addEventListener("close", () => {
    // If the socket closes before a report or error arrived, surface it instead of hanging.
    settleReject(new Error("control connection closed before the run completed"));
  });
  controlWs.addEventListener("error", () => {
    // network-level error; the close handler (or fetch) surfaces the failure
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
