import assert from "node:assert/strict";
import type { RowObservation, TestRow } from "@convai/evals-shared";
import { isFailureReasonFailure } from "@convai/evals-shared";
import { classifyFailure } from "./FailureClassifier.js";
import { computeLatency } from "./LatencyAnalysis.js";
import { checkStructure } from "./StructureCheck.js";

const baseRow: TestRow = {
  test_id: "row-001",
  session_id: "session-001",
  sequence_index: 1,
  timestamp_offset_s: 0,
  input_kind: "Text In",
  rtvi_payload_json: JSON.stringify({ type: "user_text_message", data: { text: "hello" } }),
  expected_response_behavior: "respond",
  expected_llm_call: true,
  expected_verbal_response: true,
  input_text: "hello",
};

function obs(partial: Partial<RowObservation>): RowObservation {
  return {
    test_id: "row-001",
    session_id: "session-001",
    sequence_index: 1,
    input_kind: "Text In",
    timestamps: { t_input_end: 0 },
    events: [],
    llm_called: false,
    bot_spoke: false,
    ...partial,
  };
}

{
  const structure = checkStructure(
    baseRow,
    obs({
      llm_called: true,
      bot_spoke: true,
      events: [{ name: "speakingChange:true", ts: 10 }],
    }),
  );
  assert.equal(structure.observed_behavior, "respond_with_audio");
  assert.equal(structure.overall, true);
}

{
  const row: TestRow = {
    ...baseRow,
    expected_response_behavior: "abstain",
    expected_llm_call: true,
    expected_verbal_response: false,
  };
  const structure = checkStructure(row, obs({ llm_called: false, bot_spoke: false }));
  assert.equal(structure.observed_behavior, "no_call");
  assert.equal(structure.overall, true);
  assert.equal(classifyFailure(row, obs({ llm_called: false, bot_spoke: false }), structure, null), "pass");
}

{
  const structure = checkStructure(baseRow, obs({ interrupted_by_priority_event: true }));
  const reason = classifyFailure(baseRow, obs({ interrupted_by_priority_event: true }), structure, null);
  assert.equal(structure.observed_behavior, "interrupted_by_priority_event");
  assert.equal(structure.overall, true);
  assert.equal(reason, "interrupted_by_priority_event");
  assert.equal(isFailureReasonFailure(reason), false);
}

// State-aware scoring: run_llm=auto, bot idle, user quiet -> discretionary.
// Either responding OR staying silent must count as a pass (Update #2).
{
  const dcRow: TestRow = {
    ...baseRow,
    input_kind: "Dynamic Context",
    expected_response_behavior: "abstain",
    expected_llm_call: false,
    expected_verbal_response: false,
    run_llm: "auto",
  };
  const discretionary = {
    run_llm: "auto" as const,
    bot_busy: false,
    user_speaking: false,
    category: "discretionary" as const,
    resolution: "auto_idle_either_ok",
  };
  // Bot responded on an auto idle update -> pass.
  const responded = checkStructure(
    dcRow,
    obs({
      input_kind: "Dynamic Context",
      llm_called: true,
      bot_spoke: true,
      events: [{ name: "speakingChange:true", ts: 10 }],
      resolved_expectation: discretionary,
    }),
  );
  assert.equal(responded.overall, true);
  // Bot abstained on the same auto idle update -> also pass.
  const abstained = checkStructure(
    dcRow,
    obs({ input_kind: "Dynamic Context", llm_called: false, bot_spoke: false, resolved_expectation: discretionary }),
  );
  assert.equal(abstained.overall, true);
}

// State-aware scoring: run_llm=auto while bot busy -> silent. A new audible response fails.
{
  const dcRow: TestRow = {
    ...baseRow,
    input_kind: "Dynamic Context",
    expected_response_behavior: "abstain",
    run_llm: "auto",
  };
  const silent = {
    run_llm: "auto" as const,
    bot_busy: true,
    user_speaking: false,
    category: "silent" as const,
    resolution: "auto_silent_bot_busy",
  };
  const stayedSilent = checkStructure(
    dcRow,
    obs({ input_kind: "Dynamic Context", llm_called: false, bot_spoke: false, resolved_expectation: silent }),
  );
  assert.equal(stayedSilent.overall, true);
  const spokeAnyway = checkStructure(
    dcRow,
    obs({
      input_kind: "Dynamic Context",
      llm_called: true,
      bot_spoke: true,
      events: [{ name: "speakingChange:true", ts: 10 }],
      resolved_expectation: silent,
    }),
  );
  assert.equal(spokeAnyway.overall, false);
}

// State-aware scoring: run_llm=true while bot busy -> respond (interrupt + regenerate).
{
  const dcRow: TestRow = {
    ...baseRow,
    input_kind: "Dynamic Context",
    expected_response_behavior: "respond",
    run_llm: "true",
  };
  const respond = {
    run_llm: "true" as const,
    bot_busy: true,
    user_speaking: false,
    category: "respond" as const,
    resolution: "true_interrupt_and_regenerate",
  };
  const interrupted = checkStructure(
    dcRow,
    obs({ input_kind: "Dynamic Context", interrupted_by_priority_event: true, resolved_expectation: respond }),
  );
  assert.equal(interrupted.overall, true);
}

{
  const latency = computeLatency({
    t_input_end: 0,
    t_tts_started: 100,
    t_speaking_start: 240,
    t_speaking_end: 1200,
  });
  assert.equal(latency.ttfa_ms, 100);
  assert.equal(latency.ttfb_ms, 240);
  assert.notEqual(latency.ttfb_ms, latency.ttfa_ms);
}

console.log("scoring regression tests passed");
