import type {
  CapturedEvent,
  ExpectedBehavior,
  ObservedBehavior,
  RowObservation,
  StructureMatch,
  TestRow,
} from "@convai/evals-shared";

/**
 * Derive observed behavior bucket from the captured events + flags.
 */
function deriveObservedBehavior(obs: RowObservation): ObservedBehavior {
  if (obs.interrupted_by_priority_event) return "interrupted_by_priority_event";
  if (!obs.llm_called) return "no_call";
  if (obs.bot_spoke) return "respond_with_audio";
  return "respond_silent";
}

/**
 * Check that the captured SDK event stream is consistent with the expected behavior.
 * We deliberately do NOT substring-match against `expected_server_events` from the CSV:
 * that column lists RTVI server-side event names (e.g. `bot-turn-completed`,
 * `final-user-transcription`) which the SDK does not emit verbatim. Instead we assert
 * the *shape* of the event stream a given expected behavior should produce.
 */
function eventsConsistentWithBehavior(
  expected: ExpectedBehavior,
  events: readonly CapturedEvent[],
): boolean {
  const names = new Set(events.map((e) => e.name));
  const sawBotAudio = names.has("speakingChange:true");
  const sawBotOutput = names.has("botOutput") || names.has("botTtsStarted");
  const sawLlmInvoked = sawBotAudio || sawBotOutput || names.has("llmNoResponse");

  switch (expected) {
    case "no_call":
      // For run_llm=false rows: nothing bot-side should fire.
      return !sawLlmInvoked && !sawBotAudio;
    case "abstain":
      // LLM may have been considered but no audible response.
      return !sawBotAudio;
    case "respond":
    case "respond_with_audio":
      // Expect bot to have produced something audible or textual.
      return sawBotAudio || sawBotOutput;
    case "respond_silent":
      return sawLlmInvoked && !sawBotAudio;
    case "interrupted_by_priority_event":
      return true;
  }
}

function behaviorMatches(expected: ExpectedBehavior, observed: ObservedBehavior): boolean {
  switch (expected) {
    case "respond":
    case "respond_with_audio":
      return observed === "respond_with_audio" || observed === "interrupted_by_priority_event";
    case "abstain":
      return observed === "respond_silent" || observed === "no_call" || observed === "interrupted_by_priority_event";
    case "respond_silent":
      return observed === "respond_silent" || observed === "interrupted_by_priority_event";
    case "no_call":
      return observed === "no_call";
    case "interrupted_by_priority_event":
      return observed === "interrupted_by_priority_event";
  }
}

/**
 * State-aware scoring: when the worker captured the bot/user state at input time, score
 * against the resolved run_llm directive (Dynamic Context V2 matrix) instead of the static
 * expected_response_behavior. The three categories:
 *   - "respond"       : bot must produce audible output (interruption counts).
 *   - "silent"        : bot must NOT produce a new audible response on this input.
 *   - "discretionary" : either outcome is correct (run_llm=auto, bot idle, user quiet).
 */
function checkStructureStateAware(
  obs: RowObservation,
  observed_behavior: ObservedBehavior,
): StructureMatch {
  const category = obs.resolved_expectation!.category;
  const names = new Set(obs.events.map((e) => e.name));
  const sawBotAudio = names.has("speakingChange:true");
  const sawBotOutput = names.has("botOutput") || names.has("botTtsStarted");
  const interrupted = observed_behavior === "interrupted_by_priority_event";

  if (category === "discretionary") {
    // run_llm=auto, bot idle, user quiet: respond OR abstain are both correct.
    return {
      behavior: true,
      llm_call: true,
      verbal: true,
      events: true,
      overall: true,
      observed_behavior,
    };
  }

  if (category === "respond") {
    const behavior = observed_behavior === "respond_with_audio" || interrupted;
    const verbal = obs.bot_spoke === true || interrupted;
    const llm_call = obs.llm_called === true || interrupted;
    const events = sawBotAudio || sawBotOutput || interrupted;
    return { behavior, llm_call, verbal, events, overall: behavior && llm_call && verbal && events, observed_behavior };
  }

  // category === "silent": this input must not trigger a new audible response.
  const behavior = observed_behavior === "no_call" || observed_behavior === "respond_silent";
  const verbal = obs.bot_spoke === false;
  const events = !sawBotAudio;
  // llm_call is intentionally unconstrained for silent: the server legitimately reaches
  // silence either by skipping the LLM (no_call) or via a silent LLM result.
  return { behavior, llm_call: true, verbal, events, overall: behavior && verbal && events, observed_behavior };
}

export function checkStructure(row: TestRow, obs: RowObservation): StructureMatch {
  const observed_behavior = deriveObservedBehavior(obs);

  // Prefer state-aware scoring when the worker captured the received state.
  if (obs.resolved_expectation) {
    return checkStructureStateAware(obs, observed_behavior);
  }

  // Legacy static scoring (no captured state, e.g. an older worker bundle).
  const behavior = behaviorMatches(row.expected_response_behavior, observed_behavior);
  const interrupted = observed_behavior === "interrupted_by_priority_event";
  const abstainViaNoCall =
    row.expected_response_behavior === "abstain" && observed_behavior === "no_call";
  const llm_call = interrupted || abstainViaNoCall || obs.llm_called === row.expected_llm_call;
  const verbal = interrupted || abstainViaNoCall || obs.bot_spoke === row.expected_verbal_response;
  const events = interrupted || eventsConsistentWithBehavior(row.expected_response_behavior, obs.events);
  return {
    behavior,
    llm_call,
    verbal,
    events,
    overall: behavior && llm_call && verbal && events,
    observed_behavior,
  };
}
