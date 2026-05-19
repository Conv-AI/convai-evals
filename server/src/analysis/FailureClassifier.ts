import type {
  FailureReason,
  RowObservation,
  StructureMatch,
  TestRow,
} from "@convai/evals-shared";

/**
 * Categorize a row's outcome beyond the binary structure overall pass/fail. Resolves the
 * specific failure mode so the UI can show a useful "why did this fail" string and skip
 * rows that mismatched for understandable reasons (e.g. an auto Dynamic Context fired while
 * the bot was speaking — server correctly collapsed it to no_call).
 *
 * Resolution order matters: connection_error > interrupted > pass > timeout > by_design > error.
 */
export function classifyFailure(
  row: TestRow,
  obs: RowObservation,
  structure: StructureMatch,
  sla_pass: boolean | null,
): FailureReason {
  // No observation at all (run was canceled before this row dispatched) is handled by
  // the caller skipping the row entirely. If we still ended up with a row whose
  // dispatch was registered but no events fired AND the run was canceled, this is a
  // connection_error from the row's POV.
  const sawAnyBotEvent =
    obs.events.some(
      (e) =>
        e.name === "botRespondingChange:true" ||
        e.name === "botOutput" ||
        e.name === "botTtsStarted" ||
        e.name === "speakingChange:true" ||
        e.name === "llmNoResponse" ||
        e.name === "turnEnd",
    );

  const expectedResponse =
    row.expected_response_behavior !== "no_call" &&
    row.expected_response_behavior !== "interrupted_by_priority_event";

  if (structure.observed_behavior === "interrupted_by_priority_event") {
    return "interrupted_by_priority_event";
  }

  if (structure.overall) {
    if (sla_pass === false) return "sla_miss";
    return "pass";
  }

  // Behavior didn't match. Determine whether the mismatch has a by-design explanation.
  const observedNoCall = structure.observed_behavior === "no_call";
  if (!structure.behavior && observedNoCall && (obs.dispatched_mid_turn || obs.was_canceled)) {
    return "behavior_mismatch_by_design";
  }

  // Timeout: row expected a response but no bot-side events fired at all and the input
  // window had time to register.
  if (expectedResponse && !sawAnyBotEvent && obs.timestamps.t_input_end != null) {
    return "timeout";
  }

  return "behavior_mismatch_error";
}
