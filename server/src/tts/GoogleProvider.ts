import type { ProviderImpl, ProviderOverrides } from "./TtsService.js";

// Google TTS provider. Auth precedence:
//   1) overrides.apiKey (UI-supplied) — uses REST endpoint with ?key=
//   2) process.env.CONVAI_EVALS_TTS_API_KEY — same REST path
// `overrides.endpoint` (when provided) replaces the REST base URL.
const DEFAULT_GOOGLE_TTS_BASE = "https://texttospeech.googleapis.com";

export class GoogleProvider implements ProviderImpl {
  async synthesize(text: string, voiceId: string, overrides?: ProviderOverrides): Promise<Buffer> {
    const parts = voiceId.split("-");
    const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "en-US";

    const apiKey = overrides?.apiKey ?? process.env.CONVAI_EVALS_TTS_API_KEY;
    if (!apiKey) {
      throw new Error("Google TTS API key not provided (UI input or CONVAI_EVALS_TTS_API_KEY env)");
    }
    const base = overrides?.endpoint?.replace(/\/$/, "") ?? DEFAULT_GOOGLE_TTS_BASE;
    const url = `${base}/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceId },
        audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 16000 },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`Google TTS REST failed: ${resp.status} ${err}`);
    }
    const json = (await resp.json()) as { audioContent?: string };
    if (!json.audioContent) throw new Error("Google TTS REST returned empty audioContent");
    const raw = Buffer.from(json.audioContent, "base64");
    return wrapPcmInWav(raw, 16000, 1, 16);
  }
}

function wrapPcmInWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}
