import type { WsWorkerToOrchestrator } from "@convai/evals-shared";

export class EventStream {
  private ws: WebSocket;
  private queue: WsWorkerToOrchestrator[] = [];
  private ready = false;
  private readyResolvers: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.ready = true;
      for (const m of this.queue) this.ws.send(JSON.stringify(m));
      this.queue.length = 0;
      for (const r of this.readyResolvers) r();
      this.readyResolvers.length = 0;
    });
    this.ws.addEventListener("close", () => {
      this.ready = false;
    });
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((res) => this.readyResolvers.push(res));
  }

  onMessage(handler: (data: any) => void): void {
    this.ws.addEventListener("message", (e) => {
      try {
        handler(JSON.parse((e.data as string)));
      } catch {
        // ignore malformed
      }
    });
  }

  send(msg: WsWorkerToOrchestrator): void {
    if (this.ready) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
