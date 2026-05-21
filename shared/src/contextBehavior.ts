// Resolve the expected behavior of an input from its run_llm directive AND the bot/user
// state the system was in when it received the input. This mirrors core-service Dynamic
// Context V2 gating (commit #517: bot-state-aware update queue):
//
//   run_llm=false  -> always silent (context updates without triggering a response)
//   run_llm=auto   -> bot idle & user quiet : MAY respond (either respond OR abstain is correct)
//                     bot busy              : silent (updates without interrupting)
//                     user speaking         : silent (responds after the user finishes)
//   run_llm=true   -> bot idle              : respond immediately
//                     bot busy              : respond (interrupt current response + regenerate)
//                     user speaking         : silent now (responds after the user finishes)
//   voice / text user input -> always expects a response
//
// "category" is the coarse scoring bucket:
//   respond       -> bot must produce an audible response (or interrupt)
//   silent        -> bot must NOT produce a new audible response on this input
//   discretionary -> either outcome is correct (auto, bot idle, user quiet)

import type { InputKind, ReceivedState, ResolvedExpectation, RunLlm } from "./types.js";

export function resolveExpectation(
  inputKind: InputKind,
  runLlm: RunLlm | undefined,
  state: ReceivedState,
): ResolvedExpectation {
  const { bot_busy, user_speaking } = state;

  // Direct user inputs (voice/text) always expect a response.
  if (inputKind !== "Dynamic Context") {
    return { run_llm: "n/a", bot_busy, user_speaking, category: "respond", resolution: "user_input_expects_response" };
  }

  const rl: RunLlm = runLlm ?? "auto";

  if (rl === "false") {
    return { run_llm: rl, bot_busy, user_speaking, category: "silent", resolution: "false_silent_update" };
  }

  if (rl === "true") {
    if (user_speaking) return { run_llm: rl, bot_busy, user_speaking, category: "silent", resolution: "true_deferred_user_speaking" };
    if (bot_busy)      return { run_llm: rl, bot_busy, user_speaking, category: "respond", resolution: "true_interrupt_and_regenerate" };
    return { run_llm: rl, bot_busy, user_speaking, category: "respond", resolution: "true_immediate_response" };
  }

  // run_llm === "auto"
  if (user_speaking) return { run_llm: rl, bot_busy, user_speaking, category: "silent", resolution: "auto_deferred_user_speaking" };
  if (bot_busy)      return { run_llm: rl, bot_busy, user_speaking, category: "silent", resolution: "auto_silent_bot_busy" };
  return { run_llm: rl, bot_busy, user_speaking, category: "discretionary", resolution: "auto_idle_either_ok" };
}
