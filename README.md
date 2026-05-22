# Convai Evals

Agentic evaluation toolkit for Convai Character AI infrastructure.

`convai-evals` is a public, dataset-agnostic runner for testing Convai Character AI behavior through the same customer-facing Web SDK path used by real applications. You give it a dataset of inputs (text, voice, dynamic context) and your character, and it reports how the character behaved (responded vs. stayed silent, correctly or not) and how fast (latency). It works with **any** character and **any** dataset — nothing in here is specific to one customer.

> **New here? Start with the [Getting started](#getting-started) guide below.** It walks you through running your first evaluation step by step, including exactly where to enter your Character ID, API key, and datasets. No prior experience required.

---

## Getting started

### 1. What you'll need

- A **Mac, Linux, or Windows** computer.
- **Node.js version 20 or newer.** Download it from [nodejs.org](https://nodejs.org) (pick the "LTS" version) and install it. To check it worked, open a terminal and run `node -v` — you should see something like `v20.x` or higher.
- A **Convai Character ID** and a **Convai API key** (from your Convai dashboard). You'll paste these in later — they are *not* stored in this tool.
- Your **dataset files** (`.csv`). For example, if a dataset folder was shared with you, download the `.csv` files to your computer (your Downloads folder is fine).

### 2. One-time setup

Open a terminal, go to the folder where you want the tool, and run these commands one at a time:

```bash
# get the code
git clone https://github.com/Conv-AI/convai-evals.git
cd convai-evals
git checkout feat/state-aware-context-eval

# install and build (takes a few minutes the first time)
npm install
npx playwright install chromium
npm run build
```

If every command finishes without a red error, you're ready.

### 3. Run an evaluation — the web app (recommended)

This is the easiest way and needs no command-line configuration. You'll keep **two** commands running, each in its own terminal window/tab.

**Terminal 1** — start the engine:

```bash
npm run dev:server
```

**Terminal 2** — start the web app:

```bash
npm run dev:web
```

Then open the link it prints (it will be **http://localhost:5180**) in your browser. You'll see two cards:

**a) Dataset card** — load your data:
- Click **"Upload CSV"** and pick a dataset file from wherever you saved it (e.g. your Downloads folder). *That's where any downloaded dataset goes — you select it here; there is no special folder to copy it into.*
- Or click **"Load synthetic sample"** to try the tool with built-in fake data first.

**b) Run config card** — this is where your credentials go:
- **Environment** — choose `Prod` (or Preview/Staging if instructed).
- **Character ID** — paste your Convai character ID here.
- **Convai API key** — paste your Convai API key here (it shows as dots; it is only sent to the engine on your own machine).
- **TTS for Voice In rows** — leave **Provider = Local** (free, no setup). Set **Voice ID** to a voice your computer has:
  - **Mac:** `Samantha`
  - **Linux:** `en-us`
- Leave the other settings at their defaults to start.

Finally click the big **Run** button. Progress shows on screen; when it finishes you'll see pass-rates and latency, and you can **export the report as CSV or JSON**.

> The Character ID and API key live **only in this form** (and the headless command below) — they are never written into the tool's code or saved to the repo.

### 4. Run many datasets at once (optional, for batches)

If you have several datasets and want to run them in one go (or run several at the same time), use the headless runner instead of the web app. Keep `npm run dev:server` running in one terminal, then in another terminal:

```bash
CHARACTER_ID=your-character-id \
API_KEY=your-api-key \
ENDPOINT=prod \
TTS_VOICE_ID=Samantha \
REPORT_DIR=./reports \
node scripts/run-batch.mjs /path/to/your/datasets/
```

- **Where your Character ID + API key go:** the `CHARACTER_ID=` and `API_KEY=` values in the command above. Replace the placeholder text with your real values.
- **Where your datasets go:** put the downloaded `.csv` files in any folder, then pass that folder's path as the last argument (or list individual files). Example: `node scripts/run-batch.mjs ~/Downloads/my-datasets/`.
- On Mac use `TTS_VOICE_ID=Samantha`; on Linux use `TTS_VOICE_ID=en-us`.

Full options (concurrency, staggering, server-side latency, etc.) are in **[docs/headless-runner.md](docs/headless-runner.md)**.

### 5. Where your results go

- **Web app:** shown on screen; use the **Export CSV / Export JSON** buttons to save them.
- **Headless runner:** in the `REPORT_DIR` folder (default `./reports`) — one `*.report.json` per dataset plus a `batch-summary.json` with the pass-rates and a failure breakdown.

### 6. Troubleshooting

- **`command not found: node` / `npm`** — Node.js isn't installed. Install it from [nodejs.org](https://nodejs.org) and reopen the terminal.
- **Sessions fail with "botReady timeout"** — usually the Character ID or API key is wrong, or the key doesn't match the selected Environment (a Prod key won't work on Preview, and vice-versa). Double-check all three.
- **Voice rows produce no audio / fail** — the **Voice ID** must be valid for your operating system (Mac: `Samantha`; Linux: `en-us`). Or switch the provider to Google with a key.
- **"port already in use"** — another copy is already running. Close it, or start the engine on a different port with `PORT=4100 npm run dev:server`.
- **No BigQuery needed** — behavior pass-rates and client-side latency are produced without any database access. (Server-side per-stage latency is optional; see the headless-runner doc.)

> **Note:** the `convai-evals` command-line tool (below) only *prepares and inspects* datasets — it does **not** run live evaluations and does not take a Character ID or API key. Live runs happen in the web app or the headless runner described above.

---

## Reference

### Scenario format

The canonical input is versioned JSON:

```json
{
  "schema_version": "convai-evals/v0",
  "scenario_id": "example",
  "sessions": [
    {
      "session_id": "session-001",
      "events": [
        {
          "event_id": "event-001",
          "at_s": 0,
          "input": { "kind": "text", "text": "What should I do next?" },
          "expect": { "behavior": "respond", "llm_call": true, "verbal_response": true }
        }
      ]
    }
  ]
}
```

Supported v0 input kinds are `text`, `voice`, and `dynamic_context`. Domain-specific fields belong in opaque `metadata`; do not add customer-specific columns to the public schema. See [scenario.schema.json](schemas/scenario.schema.json) and [docs/scenario-format.md](docs/scenario-format.md). CSV datasets follow [docs/csv-adapter.md](docs/csv-adapter.md).

Behavior expectations support legacy values `respond`, `abstain`, and `no_call`, plus precise values `respond_with_audio`, `respond_silent`, and `interrupted_by_priority_event`. Legacy `abstain` passes when the server reaches silence through either a silent LLM result or a clean no-call path.

### Command-line tool (`convai-evals`)

The CLI validates, converts, and inspects datasets and reports. It does **not** run live evals (use the web app or `scripts/run-batch.mjs` for that).

```bash
convai-evals validate examples/scenarios/*.json
convai-evals convert input.csv --from legacy-rtvi-csv --out scenario.json
convai-evals run scenario.json --out runtime-rows.json
convai-evals report report.json
convai-evals telemetry-ids report.json --out telemetry-ids.json
convai-evals explain scenario.json
convai-evals generate-template --kind voice-text-mix --out scenario.json
```

### Web SDK dependency

This repo does not use a Web SDK submodule. The worker imports `@convai/web-sdk` from npm and exercises:

- `ConvaiClient.connect(...)`
- `sendUserTextMessage(...)`
- `updateContext(...)`
- SDK event listeners such as transcripts, bot output, speaking state, blendshapes, and metrics

The optional `current_attention_object` field is included in the schema but is safe to omit. Use a public SDK version that supports it before making it required in scenarios.

### Diagnostics

Diagnostics are disabled by default:

```bash
DIAG_PROVIDER=none
```

Public v0 supports optional analytics API lookups:

```bash
DIAG_PROVIDER=analytics-api
CONVAI_API_KEY=...
CONVAI_ANALYTICS_BASE_URL=https://analytics-api.convai.com/v1/analytics
```

Reports preserve backend IDs when available so a coding agent can call Convai analytics APIs after a run. Direct cloud log access is intentionally outside the public default path.

Each row also carries a `correlation` block with a deterministic `client_event_id`, dispatch timestamps, and the attribution method used for response and transcript capture. Text and dynamic-context rows attempt to pass the same public-safe metadata through the SDK data message so backend telemetry can join back to eval rows when supported.

### Endpoint configuration

The server reads endpoint URLs from environment variables (defaults shown):

```bash
CONVAI_ENDPOINT_PROD=https://realtime-api.convai.com
CONVAI_ENDPOINT_PREVIEW=https://realtime-api-preview.convai.com
CONVAI_ENDPOINT_STAGING=https://realtime-api-stg.convai.com
```

Copy `.env.example` to `server/.env` if you need to override them.

### Public safety

The initial public history is meant to be a sanitized first commit: no source history from the precursor repo, no customer datasets, no customer-specific naming, no cloud diagnostics defaults, and no credentials. Synthetic examples preserve workload shapes without customer content.

## License

Apache-2.0.
