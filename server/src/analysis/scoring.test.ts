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
