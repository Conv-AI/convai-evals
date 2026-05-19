import type {
  CapturedEvent,
  ExpectedBehavior,
  RowObservation,
  StructureMatch,
  TestRow,
} from "@convai/evals-shared";

/**
 * Derive observed behavior bucket from the captured events + flags.
 */
function deriveObservedBehavior(obs: RowObservation): ExpectedBehavior {
  if (!obs.llm_called) return "no_call";
  if (obs.bot_spoke) return "respond";
  return "abstain";
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
      // Expect bot to have produced something audible or textual.
      return sawBotAudio || sawBotOutput;
  }
}

export function checkStructure(row: TestRow, obs: RowObservation): StructureMatch {
  const observed_behavior = deriveObservedBehavior(obs);
  const behavior = observed_behavior === row.expected_response_behavior;
  const llm_call = obs.llm_called === row.expected_llm_call;
  const verbal = obs.bot_spoke === row.expected_verbal_response;
  const events = eventsConsistentWithBehavior(row.expected_response_behavior, obs.events);
  return {
    behavior,
    llm_call,
    verbal,
    events,
    overall: behavior && llm_call && verbal && events,
    observed_behavior,
  };
}
