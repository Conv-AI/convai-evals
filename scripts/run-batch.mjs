// Headless batch runner for convai-evals.
//
// Drives a locally-running convai-evals server (`npm run dev:server`) over its
// /api/run + /ws/control interface — the same path the web UI uses — so you can run
// one or more datasets without the browser UI. Each dataset file becomes its own run;
// multiple datasets are launched STAGGER_MS apart so they overlap (a connect storm of
// simultaneous WebRTC connects makes sessions miss botReady).
//
// No secrets are baked in: character id, API key, and endpoint all come from the
// environment. Datasets are passed as file arguments and are never committed here.
//
// Usage:
//   CHARACTER_ID=<id> API_KEY=<key> node scripts/run-batch.mjs data/*.csv
//   CHARACTER_ID=<id> API_KEY=<key> ENDPOINT=preview STAGGER_MS=10000 \
//     TTS_VOICE_ID=Samantha REPORT_DIR=./reports node scripts/run-batch.mjs a.csv b.csv
//
// Env:
//   HARNESS_URL   server base URL            (default http://localhost:4000)
//   CHARACTER_ID  Convai character id        (required)
//   API_KEY       Convai API key             (required)
//   ENDPOINT      prod | preview | staging   (default prod)
//   ENDPOINT_URL  explicit override for the endpoint base URL
//   CONCURRENCY   sessions per run           (default: unique session_ids in the file)
//   STAGGER_MS    delay between dataset launches (default 0)
//   SPEED         scenario speed multiplier  (default 1)
//   SLA_VOICE_MS  voice/anim SLA ms          (default 3000)
//   SLA_TEXT_MS   text-out SLA ms            (default 1200)
//   TTS_PROVIDER  local | google            (default local)
//   TTS_VOICE_ID  TTS voice                  (default: macOS=Samantha, otherwise en-us)
//   DEBUG         true|false -> server turn-trace (default false; true needs no BQ)
//   JUDGE         true|false                 (default false)
//   REPORT_DIR    output dir                 (default ./reports)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";

const ENDPOINT_URLS = {
  prod: "https://realtime-api.convai.com",
  preview: "https://realtime-api-preview.convai.com",
  staging: "https://realtime-api-stg.convai.com",
};

const HARNESS = process.env.HARNESS_URL || "http://localhost:4000";
const CHARACTER_ID = process.env.CHARACTER_ID;
const API_KEY = process.env.API_KEY;
const ENDPOINT = (process.env.ENDPOINT || "prod").toLowerCase();
const ENDPOINT_URL = process.env.ENDPOINT_URL || ENDPOINT_URLS[ENDPOINT];
const STAGGER_MS = Number(process.env.STAGGER_MS ?? "0");
const SPEED = Number(process.env.SPEED ?? "1");
const SLA_VOICE_MS = Number(process.env.SLA_VOICE_MS ?? "3000");
const SLA_TEXT_MS = Number(process.env.SLA_TEXT_MS ?? "1200");
const TTS_PROVIDER = process.env.TTS_PROVIDER || "local";
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || (process.platform === "darwin" ? "Samantha" : "en-us");
const DEBUG = /^true$/i.test(process.env.DEBUG ?? "");
const JUDGE = /^true$/i.test(process.env.JUDGE ?? "");
const REPORT_DIR = process.env.REPORT_DIR || "./reports";

if (!CHARACTER_ID || !API_KEY) {
  console.error("CHARACTER_ID and API_KEY env vars are required.");
  process.exit(2);
}
if (!ENDPOINT_URL) {
  console.error(`Unknown ENDPOINT '${ENDPOINT}' (expected prod|preview|staging) and no ENDPOINT_URL set.`);
  process.exit(2);
}

// --- dataset args -> file list (accept files or directories of .csv/.json) ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/run-batch.mjs <dataset.csv|dataset.json|dir> [more...]");
  process.exit(2);
}
const files = [];
for (const a of args) {
  const p = resolve(a);
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p).sort()) {
      if (f.endsWith(".csv") || f.endsWith(".json")) files.push(join(p, f));
    }
  } else files.push(p);
}

// --- input parsing (CSV rows or JSON rows array) ---
function parseCsvLine(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  }
  out.push(cur); return out;
}
function rowsFromCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const bool = (v) => /^true$/i.test(v);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l); const r = {};
    for (let i = 0; i < headers.length; i++) r[headers[i]] = cells[i] ?? "";
    return {
      test_id: r.test_id, session_id: r.session_id,
      sequence_index: parseInt(r.sequence_index, 10),
      timestamp_offset_s: parseFloat(r.timestamp_offset_s),
      input_kind: r.input_kind, rtvi_payload_json: r.rtvi_payload_json,
      expected_response_behavior: r.expected_response_behavior,
      expected_llm_call: bool(r.expected_llm_call),
      expected_verbal_response: bool(r.expected_verbal_response),
      input_text: r.input_text || undefined,
      current_attention_object: r.current_attention_object || undefined,
      mode: r.mode || undefined,
      run_llm: r.run_llm || undefined,
    };
  });
}
function loadRows(file) {
  const text = readFileSync(file, "utf-8");
  if (extname(file).toLowerCase() === ".json") {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.sessions) {
      throw new Error(`${basename(file)} looks like a scenario JSON — convert it first: convai-evals convert ${basename(file)} > rows.json`);
    }
    throw new Error(`${basename(file)} is not a rows array`);
  }
  return rowsFromCsv(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startRun(file) {
  const filename = basename(file);
  const rows = loadRows(file);
  const sessionIds = [...new Set(rows.map((r) => r.session_id))];
  const concurrency = Number(process.env.CONCURRENCY ?? sessionIds.length ?? 1) || 1;
  const config = {
    endpoint: ENDPOINT, endpointUrl: ENDPOINT_URL,
    characterId: CHARACTER_ID, apiKey: API_KEY,
    sessionIds, concurrency, speedMultiplier: SPEED,
    slaVoiceAnimMs: SLA_VOICE_MS, slaTextOutMs: SLA_TEXT_MS,
    judgeEnabled: JUDGE, judgeEveryNth: 1,
    ttsProvider: TTS_PROVIDER, ttsVoiceId: TTS_VOICE_ID,
    debug: DEBUG,
  };

  let resolveHandshake, resolveReport;
  const handshakeDone = new Promise((r) => { resolveHandshake = r; });
  const reportDone = new Promise((r) => { resolveReport = r; });
  const t0 = Date.now();
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; resolveReport(v); } };

  const ws = new WebSocket(HARNESS.replace(/^http/, "ws") + "/ws/control");
  ws.addEventListener("open", () => {
    fetch(`${HARNESS}/api/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ config, rows }),
    }).catch(() => {});
  });
  let completed = 0;
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "run_started") { resolveHandshake(); console.log(`  [${filename}] run_started ${m.run_id}`); }
    else if (m.type === "row_complete") { if (++completed % 100 === 0) console.log(`  [${filename}] rows ${completed}/${rows.length}`); }
    else if (m.type === "run_complete") { console.log(`  [${filename}] run_complete (${((Date.now() - t0) / 1000).toFixed(0)}s)`); finish(m.report); }
    else if (m.type === "run_error") { console.error(`  [${filename}] run_error: ${m.message}`); finish(null); }
    else if (m.type === "run_canceled") { console.error(`  [${filename}] run_canceled`); finish(null); }
  });
  ws.addEventListener("error", (e) => console.error(`  [${filename}] ws error:`, e.message ?? e));
  setTimeout(() => resolveHandshake(), 8000);
  const safety = setTimeout(() => { console.error(`  [${filename}] safety timeout`); finish(null); }, 45 * 60 * 1000);

  const reportPromise = reportDone.then((report) => {
    clearTimeout(safety); try { ws.close(); } catch { /* noop */ }
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    if (!report) return { filename, error: "no report", elapsedSec };
    const counts = {};
    for (const r of report.per_row) counts[r.failure_reason] = (counts[r.failure_reason] ?? 0) + 1;
    const outPath = join(REPORT_DIR, filename.replace(/\.(csv|json)$/i, "") + ".report.json");
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    return { filename, elapsedSec, pass_rate: report.summary.structure_pass_rate_overall, row_count: report.run_metadata.row_count, counts, outPath };
  });
  return { filename, rowCount: rows.length, handshakeDone, reportPromise };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  console.log(`convai-evals batch · ${ENDPOINT} (${ENDPOINT_URL}) · ${files.length} dataset(s) · stagger ${STAGGER_MS}ms · debug=${DEBUG} · tts ${TTS_PROVIDER}/${TTS_VOICE_ID}`);
  const totalStart = Date.now();
  const reportPromises = [];
  for (let i = 0; i < files.length; i++) {
    const { filename, rowCount, handshakeDone, reportPromise } = startRun(files[i]);
    console.log(`[${i + 1}/${files.length}] launching ${filename} (${rowCount} rows)`);
    reportPromises.push(reportPromise);
    await handshakeDone; // bind this run's control socket before the next POST
    if (i < files.length - 1) await sleep(STAGGER_MS);
  }
  console.log(`\nAll ${files.length} launched · awaiting completion...\n`);
  const results = await Promise.all(reportPromises);
  const totalMin = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);

  console.log(`\n${"=".repeat(72)}\nSUMMARY (${totalMin} min) · ${ENDPOINT}\n${"=".repeat(72)}`);
  const aggregate = {};
  for (const r of results) {
    if (r.error) { console.log(`  ${r.filename.padEnd(48)} ERROR: ${r.error}`); continue; }
    for (const [k, v] of Object.entries(r.counts)) aggregate[k] = (aggregate[k] ?? 0) + v;
    console.log(`  ${r.filename.padEnd(48)} ${(r.pass_rate * 100).toFixed(1).padStart(5)}%  ${JSON.stringify(r.counts)}`);
  }
  console.log("\nAggregate failure_reason counts:");
  for (const [k, v] of Object.entries(aggregate).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(34)} ${v}`);
  writeFileSync(join(REPORT_DIR, "batch-summary.json"), JSON.stringify({ endpoint: ENDPOINT, total_elapsed_min: parseFloat(totalMin), aggregate_failure_counts: aggregate, per_dataset: results }, null, 2));
  console.log(`\nsaved → ${join(REPORT_DIR, "batch-summary.json")}`);
}
main().catch((e) => { console.error("BATCH FAILED:", e); process.exit(1); });
