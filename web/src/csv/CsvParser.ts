import Papa from "papaparse";
import {
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  parseBoolean,
  type CsvColumnSpec,
  type TestRow,
  type ContextMode,
  type RunLlm,
} from "@convai/evals-shared";

export interface CsvParseResult {
  rows: TestRow[];
  warnings: string[];
  bucket_counts: Record<string, number>;
  voice_in_count: number;
  text_in_count: number;
  session_ids: string[];
}

export class CsvParseError extends Error {
  constructor(message: string, public details: string[]) {
    super(message);
  }
}

export async function parseCsvFile(file: File): Promise<CsvParseResult> {
  const text = await file.text();
  return parseCsvText(text);
}

export function parseCsvText(text: string): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length > 0) {
    throw new CsvParseError("CSV parse errors", parsed.errors.map((e) => e.message));
  }
  const headerSet = new Set(parsed.meta.fields ?? []);
  const missing = REQUIRED_COLUMNS.filter((c) => !headerSet.has(c.name));
  if (missing.length > 0) {
    throw new CsvParseError(
      `CSV missing required columns: ${missing.map((m) => m.name).join(", ")}`,
      missing.map((m) => m.name),
    );
  }

  const warnings: string[] = [];
  const rows: TestRow[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of parsed.data.entries()) {
    try {
      const row = coerceRow(raw, i + 2);
      if (ids.has(row.test_id)) {
        warnings.push(`Duplicate test_id ${row.test_id} at row ${i + 2}`);
      }
      ids.add(row.test_id);
      rows.push(row);
    } catch (e) {
      throw new CsvParseError(`Row ${i + 2}: ${e instanceof Error ? e.message : String(e)}`, []);
    }
  }
  const bucket_counts = bucketCounts(rows);
  const voice_in_count = rows.filter((r) => r.input_kind === "Voice In").length;
  const text_in_count = rows.filter((r) => r.input_kind === "Text In").length;
  const session_ids = [...new Set(rows.map((r) => r.session_id))];
  return { rows, warnings, bucket_counts, voice_in_count, text_in_count, session_ids };
}

function coerceRow(raw: Record<string, string>, rowNum: number): TestRow {
  const get = (name: string) => raw[name]?.trim() ?? "";
  const requireEnum = (spec: CsvColumnSpec, value: string) => {
    if (!spec.enumValues!.includes(value)) {
      throw new Error(`column ${spec.name}=${value} not in ${spec.enumValues!.join("|")}`);
    }
    return value;
  };
  const input_kind = requireEnum(byName("input_kind"), get("input_kind")) as TestRow["input_kind"];
  const behavior = requireEnum(byName("expected_response_behavior"), get("expected_response_behavior")) as TestRow["expected_response_behavior"];

  const payloadRaw = get("rtvi_payload_json");
  let payload: any;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    throw new Error(`rtvi_payload_json is not valid JSON at row ${rowNum}`);
  }
  const expectedType = input_kind === "Voice In" || input_kind === "Text In" ? "user_text_message" : "context-update";
  if (payload?.type !== expectedType) {
    throw new Error(`rtvi_payload_json type=${payload?.type} does not match input_kind=${input_kind} (expected ${expectedType})`);
  }

  const row: TestRow = {
    test_id: get("test_id"),
    session_id: get("session_id"),
    sequence_index: parseInt(get("sequence_index"), 10),
    timestamp_offset_s: parseFloat(get("timestamp_offset_s")),
    input_kind,
    rtvi_payload_json: payloadRaw,
    expected_response_behavior: behavior,
    expected_llm_call: parseBoolean(get("expected_llm_call")),
    expected_verbal_response: parseBoolean(get("expected_verbal_response")),
  };
  for (const opt of OPTIONAL_COLUMNS) {
    const v = get(opt.name);
    if (!v) continue;
    if (opt.name === "mode") row.mode = v as ContextMode;
    else if (opt.name === "run_llm") row.run_llm = v as RunLlm;
    else if (opt.name === "metadata_json") {
      try {
        row.metadata = JSON.parse(v) as Record<string, unknown>;
      } catch {
        throw new Error(`metadata_json is not valid JSON at row ${rowNum}`);
      }
    }
    else (row as any)[opt.name] = v;
  }
  if (!row.test_id) throw new Error(`missing test_id at row ${rowNum}`);
  if (!row.session_id) throw new Error(`missing session_id at row ${rowNum}`);
  if (Number.isNaN(row.sequence_index)) throw new Error(`invalid sequence_index at row ${rowNum}`);
  if (Number.isNaN(row.timestamp_offset_s)) throw new Error(`invalid timestamp_offset_s at row ${rowNum}`);
  if ((input_kind === "Voice In" || input_kind === "Text In") && !(row.input_text ?? payload?.data?.text)) {
    throw new Error(`${input_kind} row ${row.test_id} has no input_text or payload data.text`);
  }
  return row;
}

function byName(name: string): CsvColumnSpec {
  const found = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].find((c) => c.name === name);
  if (!found) throw new Error(`unknown column spec: ${name}`);
  return found;
}

function bucketCounts(rows: TestRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    voice_in_true: 0,
    text_in_true: 0,
    dyn_true: 0,
    dyn_auto: 0,
    dyn_false: 0,
    other: 0,
  };
  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  for (const r of rows) {
    if (r.input_kind === "Voice In") {
      bump("voice_in_true");
      continue;
    }
    if (r.input_kind === "Text In") {
      bump("text_in_true");
      continue;
    }
    const runLlm = r.run_llm ?? guessRunLlm(r.rtvi_payload_json);
    if (runLlm === "true") bump("dyn_true");
    else if (runLlm === "auto") bump("dyn_auto");
    else if (runLlm === "false") bump("dyn_false");
    else bump("other");
  }
  return counts;
}

function guessRunLlm(payload: string): RunLlm | null {
  try {
    const v = JSON.parse(payload)?.data?.run_llm;
    if (v === "true" || v === "false" || v === "auto") return v;
  } catch {
    // ignore
  }
  return null;
}
