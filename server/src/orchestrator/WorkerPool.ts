import type { WorkerHandle } from "./WorkerHandle.js";

/**
 * Limits how many WorkerHandle launches run concurrently.
 * Callers submit a factory that resolves once that worker finishes; this gates only the launch+wait
 * cycle, not the construction itself (so handles can be pre-bound to WS endpoints).
 */
export class WorkerPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private concurrency: number) {}

  async runWith<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

export async function runAllSessions(
  handles: WorkerHandle[],
  concurrency: number,
  perSessionTimeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const pool = new WorkerPool(concurrency);
  // Stagger session launches so N simultaneous LiveKit/WebRTC connects don't collide
  // (a connect storm makes most sessions miss botReady). Env LAUNCH_STAGGER_MS (default 0).
  const staggerMs = Number(process.env.LAUNCH_STAGGER_MS ?? "0");
  await Promise.all(
    handles.map((h, idx) =>
      pool.runWith(async () => {
        if (signal?.aborted) return; // never launched
        if (staggerMs > 0) await new Promise((r) => setTimeout(r, idx * staggerMs));
        if (signal?.aborted) return;
        try {
          await h.launch();
          await h.waitForCompletion(perSessionTimeoutMs);
        } catch (e) {
          // If the run was aborted, swallow per-session errors; the cancel path handles teardown.
          if (!signal?.aborted) throw e;
        } finally {
          await h.shutdown();
        }
      }),
    ),
  );
}
