import type { TurnTrace } from "@convai/evals-shared";

/**
 * Taps the LiveKit data channel on the ConvaiClient's underlying room to surface
 * `turn-trace` RTVI messages. The SDK's MessageHandler currently has no handler for
 * type "turn-trace" and silently drops them; we attach a parallel listener so we can
 * route the timeline to the right row.
 *
 * SDK assumption: ConvaiClient exposes `.room` (a livekit.Room). Verified against
 * @convai/web-sdk dist/core/ConvaiClient.js:136-138. If a future SDK release adds
 * `client.on("turnTrace", ...)` directly, delete this file and switch to that.
 *
 * Returns an uninstaller. Stash it next to other SDK listener offs so disconnect can
 * tear it down cleanly.
 */
export function installTurnTraceTap(client: any, onTrace: (t: TurnTrace) => void): () => void {
  const room = client?.room;
  if (!room || typeof room.on !== "function") {
    throw new Error("ConvaiClient.room not present — SDK version mismatch?");
  }
  const decoder = new TextDecoder();
  const handler = (payload: Uint8Array) => {
    let msg: unknown;
    try {
      msg = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string; data?: unknown };
    // Turn-trace is published as an RTVIServerMessageFrame, so it arrives as
    // `{type:"server-message", data:{type:"turn-trace", ...}}` — NOT at the top level.
    // Match either the top-level type or the inner server-message data.type.
    const innerType =
      m.type === "server-message" && m.data && typeof m.data === "object"
        ? (m.data as { type?: string }).type
        : undefined;
    if (m.type !== "turn-trace" && innerType !== "turn-trace") return;
    const payloadObj = (m.data && typeof m.data === "object" ? m.data : m) as TurnTrace;
    onTrace(payloadObj);
  };
  // livekit-client RoomEvent.DataReceived === "dataReceived"
  room.on("dataReceived", handler);
  return () => {
    try {
      room.off("dataReceived", handler);
    } catch {
      // ignore
    }
  };
}
