import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TtsProvider } from "@convai/evals-shared";
import { GoogleProvider } from "./GoogleProvider.js";
import { LocalProvider } from "./LocalProvider.js";

export interface ProviderOverrides {
  apiKey?: string;
  endpoint?: string;
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  provider: TtsProvider;
  overrides?: ProviderOverrides;
}

export interface TtsResult {
  cacheKey: string;
  wavPath: string;
  cached: boolean;
}

export interface ProviderImpl {
  synthesize(text: string, voiceId: string, overrides?: ProviderOverrides): Promise<Buffer>;
}

export class TtsService {
  private cacheDir: string;
  private providers: Record<TtsProvider, ProviderImpl>;
  private inflight = new Map<string, Promise<TtsResult>>();

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.providers = {
      local: new LocalProvider(),
      google: new GoogleProvider(),
    };
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  cacheKey({ text, voiceId, provider, overrides }: TtsRequest): string {
    // Cache key includes overrides so swapping the endpoint doesn't reuse old WAVs.
    const endpointKey = overrides?.endpoint ?? "";
    return createHash("sha256")
      .update(`${provider}|${voiceId}|${endpointKey}|${text}`)
      .digest("hex");
  }

  wavPathFor(cacheKey: string): string {
    return path.join(this.cacheDir, `${cacheKey}.wav`);
  }

  /**
   * Synthesize or return from cache. Deduplicates concurrent in-flight requests by cacheKey.
   */
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const cacheKey = this.cacheKey(req);
    const wavPath = this.wavPathFor(cacheKey);

    try {
      await fs.access(wavPath);
      return { cacheKey, wavPath, cached: true };
    } catch {
      // miss, fall through
    }

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
      const provider = this.providers[req.provider];
      if (!provider) throw new Error(`Unknown TTS provider: ${req.provider}`);
      const wav = await provider.synthesize(req.text, req.voiceId, req.overrides);
      const tmp = `${wavPath}.tmp`;
      await fs.writeFile(tmp, wav);
      await fs.rename(tmp, wavPath);
      return { cacheKey, wavPath, cached: false } as TtsResult;
    })();

    this.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /**
   * Batch pre-generation with bounded concurrency. Emits onProgress after each completion.
   */
  async preGenerate(
    requests: TtsRequest[],
    options: { concurrency?: number; onProgress?: (done: number, total: number, key: string) => void } = {},
  ): Promise<Map<string, TtsResult>> {
    const { concurrency = 10, onProgress } = options;
    const results = new Map<string, TtsResult>();
    // Dedup
    const unique = new Map<string, TtsRequest>();
    for (const r of requests) {
      unique.set(this.cacheKey(r), r);
    }
    const queue = [...unique.values()];
    let done = 0;
    const total = queue.length;

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const req = queue.shift();
        if (!req) break;
        const key = this.cacheKey(req);
        const res = await this.synthesize(req);
        results.set(key, res);
        done += 1;
        onProgress?.(done, total, key);
      }
    });

    await Promise.all(workers);
    return results;
  }
}
