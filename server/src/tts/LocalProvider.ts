import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ProviderImpl, ProviderOverrides } from "./TtsService.js";

// Free, offline TTS via the host OS's built-in speech synthesis.
//   macOS: `say -v <voice> -o <file>.aiff` → afconvert to 16kHz mono WAV
//   Linux: `espeak -v <voice> -w <file>.wav -s 165 <text>`  (or espeak-ng)
// `voiceId` is passed straight through to the OS tool. For macOS the default voice ID is "Samantha";
// for Linux the default is "en". Pass `--list` style queries to the system tools to see what's available.
//
// No API key, no network call, no UI inputs needed. This is the recommended provider when you just
// want to run evals end-to-end without setting up cloud TTS.
export class LocalProvider implements ProviderImpl {
  async synthesize(text: string, voiceId: string, _overrides?: ProviderOverrides): Promise<Buffer> {
    const platform = os.platform();
    if (platform === "darwin") return synthesizeMac(text, voiceId);
    if (platform === "linux") return synthesizeLinux(text, voiceId);
    throw new Error(`local TTS not supported on platform ${platform}; use a cloud provider`);
  }
}

async function synthesizeMac(text: string, voiceId: string): Promise<Buffer> {
  const voice = voiceId && voiceId.trim() !== "" ? voiceId.trim() : "Samantha";
  const tmpDir = os.tmpdir();
  const stem = path.join(tmpDir, `convai-evals-tts-${randomBytes(8).toString("hex")}`);
  const aiffPath = `${stem}.aiff`;
  const wavPath = `${stem}.wav`;
  try {
    await run("say", ["-v", voice, "-o", aiffPath, text]);
    await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiffPath, wavPath]);
    return await fs.readFile(wavPath);
  } finally {
    await Promise.allSettled([fs.unlink(aiffPath), fs.unlink(wavPath)]);
  }
}

async function synthesizeLinux(text: string, voiceId: string): Promise<Buffer> {
  const voice = voiceId && voiceId.trim() !== "" ? voiceId.trim() : "en";
  const tmpDir = os.tmpdir();
  const wavPath = path.join(tmpDir, `convai-evals-tts-${randomBytes(8).toString("hex")}.wav`);
  try {
    // Prefer espeak-ng if available, fall back to espeak.
    const exe = (await isOnPath("espeak-ng")) ? "espeak-ng" : "espeak";
    await run(exe, ["-v", voice, "-s", "165", "-w", wavPath, text]);
    return await fs.readFile(wavPath);
  } finally {
    await fs.unlink(wavPath).catch(() => undefined);
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
