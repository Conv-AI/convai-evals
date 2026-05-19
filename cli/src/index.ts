#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENARIO_SCHEMA_VERSION,
  assertScenario,
  explainScenario,
  scenarioToTestRows,
  validateScenario,
  type EvalEvent,
  type EvalScenario,
  type ScenarioInput,
  type TestRow,
} from "@convai/evals-shared";

type Command =
  | "validate"
  | "convert"
  | "run"
  | "report"
  | "explain"
  | "generate-template"
  | "help"
  | "--help"
  | "-h";

const command = (process.argv[2] ?? "help") as Command;
const args = process.argv.slice(3);

try {
  switch (command) {
    case "validate":
      await validateCommand(args);
      break;
    case "convert":
      await convertCommand(args);
      break;
    case "run":
      await runCommand(args);
      break;
    case "report":
      await reportCommand(args);
      break;
    case "explain":
      await explainCommand(args);
      break;
    case "generate-template":
      await generateTemplateCommand(args);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}

async function validateCommand(files: string[]): Promise<void> {
  if (files.length === 0) throw new Error("usage: convai-evals validate <scenario.json...>");
  let failed = false;
  for (const file of files) {
    const raw = await readJson(file);
    const result = validateScenario(raw);
    if (result.ok) {
      console.log(`valid: ${file}`);
    } else {
      failed = true;
      console.error(`invalid: ${file}`);
      for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function explainCommand(files: string[]): Promise<void> {
  if (files.length !== 1) throw new Error("usage: convai-evals explain <scenario.json>");
  const scenario = await readScenario(files[0]!);
  console.log(explainScenario(scenario));
}

async function runCommand(rawArgs: string[]): Promise<void> {
  const { positional, options } = parseArgs(rawArgs);
  const scenarioPath = positional[0];
  if (!scenarioPath) throw new Error("usage: convai-evals run <scenario.json> [--out rows.json]");
  const scenario = await readScenario(scenarioPath);
  const rows = scenarioToTestRows(scenario);
  const out = options.get("out");
  if (out) {
    await fs.writeFile(out, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`wrote ${rows.length} runtime rows to ${out}`);
  } else {
    console.log(`ready: ${scenario.scenario_id}`);
    console.log(`rows: ${rows.length}`);
    console.log("Start the local server/UI with npm run dev:server and npm run dev:web to execute browser-backed runs.");
  }
}

async function convertCommand(rawArgs: string[]): Promise<void> {
  const { positional, options } = parseArgs(rawArgs);
  const inputPath = positional[0];
  if (!inputPath) {
    throw new Error("usage: convai-evals convert <input.csv> --from legacy-rtvi-csv --out scenario.json");
  }
  const from = options.get("from") ?? "legacy-rtvi-csv";
  if (from !== "legacy-rtvi-csv" && from !== "rtvi-table-v0") {
    throw new Error(`unsupported adapter: ${from}`);
  }
  const out = options.get("out");
  if (!out) throw new Error("convert requires --out scenario.json");

  const csv = await fs.readFile(inputPath, "utf8");
  const rows = parseLegacyCsv(csv);
  const scenario = legacyRowsToScenario(rows, path.basename(inputPath, path.extname(inputPath)));
  await fs.writeFile(out, `${JSON.stringify(scenario, null, 2)}\n`);
  console.log(`converted ${rows.length} rows to ${out}`);
}

async function reportCommand(files: string[]): Promise<void> {
  if (files.length !== 1) throw new Error("usage: convai-evals report <report.json>");
  const report = await readJson(files[0]!);
  const rows = Array.isArray(report?.per_row) ? report.per_row : [];
  const failures = rows.filter((row: any) => row?.failure_reason && row.failure_reason !== "pass");
  console.log(`run_id: ${report?.run_metadata?.run_id ?? "unknown"}`);
  console.log(`rows: ${rows.length}`);
  console.log(`failures: ${failures.length}`);
  if (report?.summary?.structure_pass_rate_overall != null) {
    console.log(`structure_pass_rate: ${(report.summary.structure_pass_rate_overall * 100).toFixed(1)}%`);
  }
}

async function generateTemplateCommand(rawArgs: string[]): Promise<void> {
  const { options } = parseArgs(rawArgs);
  const kind = options.get("kind") ?? "dynamic-context-long-session";
  const out = options.get("out");
  const source = path.join(repoRoot(), "examples", "scenarios", `${kind}.json`);
  const text = await fs.readFile(source, "utf8");
  if (out) {
    await fs.writeFile(out, text.endsWith("\n") ? text : `${text}\n`);
    console.log(`wrote ${kind} template to ${out}`);
  } else {
    process.stdout.write(text);
  }
}

function printHelp(): void {
  console.log(`convai-evals

Agentic evaluation toolkit for Convai Character AI infrastructure.

Commands:
  validate <scenario.json...>                  Validate scenario files.
  convert <input.csv> --from legacy-rtvi-csv --out scenario.json
                                               Convert legacy RTVI table CSV to scenario JSON.
  run <scenario.json> [--out rows.json]         Validate and emit runtime rows for the browser runner.
  report <report.json>                         Summarize a machine-readable report.
  explain <scenario.json>                      Print an agent-readable scenario summary.
  generate-template --kind <name> [--out file] Copy a synthetic scenario template.
`);
}

async function readScenario(file: string): Promise<EvalScenario> {
  const raw = await readJson(file);
  assertScenario(raw);
  return raw;
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function parseArgs(raw: string[]): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = raw[i + 1];
    if (!value || value.startsWith("--")) {
      options.set(key, "true");
    } else {
      options.set(key, value);
      i += 1;
    }
  }
  return { positional, options };
}

function parseLegacyCsv(text: string): TestRow[] {
  const records = parseCsvRecords(text);
  const header = records.shift();
  if (!header) return [];
  const rows: TestRow[] = [];
  for (const [index, values] of records.entries()) {
    if (values.length === 1 && values[0]?.trim() === "") continue;
    const raw: Record<string, string> = {};
    header.forEach((name, i) => {
      raw[name.trim()] = values[i]?.trim() ?? "";
    });
    rows.push(coerceLegacyRow(raw, index + 2));
  }
  return rows;
}

function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      record.push(current);
      current = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      record.push(current);
      rows.push(record);
      current = "";
      record = [];
      continue;
    }
    current += ch;
  }
  if (current.length || record.length) {
    record.push(current);
    rows.push(record);
  }
  return rows;
}

function coerceLegacyRow(raw: Record<string, string>, rowNum: number): TestRow {
  const required = [
    "test_id",
    "session_id",
    "sequence_index",
    "timestamp_offset_s",
    "input_kind",
    "rtvi_payload_json",
    "expected_response_behavior",
    "expected_llm_call",
    "expected_verbal_response",
  ];
  for (const key of required) {
    if (!raw[key]) throw new Error(`row ${rowNum}: missing ${key}`);
  }
  const payload = JSON.parse(raw.rtvi_payload_json!);
  const metadata = raw.metadata_json ? JSON.parse(raw.metadata_json) as Record<string, unknown> : undefined;
  return {
    test_id: raw.test_id!,
    session_id: raw.session_id!,
    sequence_index: Number(raw.sequence_index),
    timestamp_offset_s: Number(raw.timestamp_offset_s),
    input_kind: raw.input_kind as TestRow["input_kind"],
    rtvi_payload_json: JSON.stringify(payload),
    expected_response_behavior: raw.expected_response_behavior as TestRow["expected_response_behavior"],
    expected_llm_call: parseBool(raw.expected_llm_call),
    expected_verbal_response: parseBool(raw.expected_verbal_response),
    expected_server_events: raw.expected_server_events || undefined,
    expected_ai_response_example: raw.expected_ai_response_example || undefined,
    safety_or_edge_case_tags: raw.safety_or_edge_case_tags || undefined,
    input_text: raw.input_text || payload?.data?.text,
    current_attention_object: raw.current_attention_object || payload?.data?.current_attention_object,
    mode: (raw.mode || payload?.data?.mode) as TestRow["mode"],
    run_llm: (raw.run_llm || payload?.data?.run_llm) as TestRow["run_llm"],
    metadata,
  };
}

function legacyRowsToScenario(rows: TestRow[], scenarioId: string): EvalScenario {
  const bySession = new Map<string, TestRow[]>();
  for (const row of rows) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id)!.push(row);
  }
  return {
    schema_version: SCENARIO_SCHEMA_VERSION,
    scenario_id: slug(scenarioId),
    title: scenarioId,
    tags: ["converted", "legacy-rtvi-csv"],
    sessions: Array.from(bySession.entries()).map(([sessionId, sessionRows]) => ({
      session_id: sessionId,
      events: sessionRows
        .sort((a, b) => a.sequence_index - b.sequence_index)
        .map((row): EvalEvent => ({
          event_id: row.test_id,
          at_s: row.timestamp_offset_s,
          input: inputFromRow(row),
          expect: {
            behavior: row.expected_response_behavior,
            llm_call: row.expected_llm_call,
            verbal_response: row.expected_verbal_response,
            required_events: splitList(row.expected_server_events),
            ai_response_example: row.expected_ai_response_example,
            safety_or_edge_case_tags: splitList(row.safety_or_edge_case_tags),
          },
          metadata: row.metadata,
        })),
    })),
  };
}

function inputFromRow(row: TestRow): ScenarioInput {
  const payload = JSON.parse(row.rtvi_payload_json);
  const text = row.input_text ?? payload?.data?.text ?? "";
  if (row.input_kind === "Text In") return { kind: "text", text };
  if (row.input_kind === "Voice In") return { kind: "voice", text };
  return {
    kind: "dynamic_context",
    text,
    mode: row.mode ?? payload?.data?.mode,
    run_llm: row.run_llm ?? payload?.data?.run_llm,
    current_attention_object: row.current_attention_object ?? payload?.data?.current_attention_object,
  };
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function parseBool(value: string | undefined): boolean {
  return ["true", "1", "yes", "y"].includes((value ?? "").trim().toLowerCase());
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "converted-scenario";
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}
