# Headless batch runner

`scripts/run-batch.mjs` runs one or more datasets against a locally-running
`convai-evals` server without the web UI. It uses the same `/api/run` + `/ws/control`
path the browser UI uses, so results are identical. Each dataset file becomes its own
run; multiple datasets are launched `STAGGER_MS` apart so their sessions overlap.

No credentials are baked into the script — character id, API key, and endpoint all come
from the environment. Datasets are passed as file arguments and are never stored in this
repo.

## Prerequisites

```bash
npm install
npx playwright install chromium     # the worker drives a headless browser
npm run build                       # builds shared, cli, worker, server
```

## Run

Start the server in one terminal:

```bash
npm run dev:server                  # listens on http://localhost:4000 (PORT to override)
```

In another terminal, point the runner at your datasets:

```bash
CHARACTER_ID=<your-character-id> \
API_KEY=<your-api-key> \
ENDPOINT=prod \
TTS_VOICE_ID=Samantha \
REPORT_DIR=./reports \
node scripts/run-batch.mjs path/to/dataset_01.csv path/to/dataset_02.csv
```

To reproduce a 10-concurrent staggered run (each dataset is one session):

```bash
CHARACTER_ID=<id> API_KEY=<key> ENDPOINT=prod STAGGER_MS=10000 \
  node scripts/run-batch.mjs path/to/datasets/
```

Reports land in `REPORT_DIR` as `<dataset>.report.json`, plus a `batch-summary.json`
with per-dataset pass-rates and aggregate failure counts.

## Environment

| Var | Default | Notes |
|---|---|---|
| `HARNESS_URL` | `http://localhost:4000` | server base URL |
| `CHARACTER_ID` | — | **required** |
| `API_KEY` | — | **required** |
| `ENDPOINT` | `prod` | `prod` \| `preview` \| `staging` |
| `ENDPOINT_URL` | (from `ENDPOINT`) | explicit override |
| `CONCURRENCY` | unique sessions in file | sessions launched per run |
| `STAGGER_MS` | `0` | delay between dataset launches |
| `SPEED` | `1` | scenario speed multiplier |
| `SLA_VOICE_MS` / `SLA_TEXT_MS` | `3000` / `1200` | SLA thresholds |
| `TTS_PROVIDER` | `local` | `local` (OS TTS) or `google` |
| `TTS_VOICE_ID` | macOS `Samantha`, else `en-us` | **platform-specific** (see below) |
| `DEBUG` | `false` | server turn-trace; see below |
| `JUDGE` | `false` | LLM-judge scoring |
| `REPORT_DIR` | `./reports` | output directory |

## TTS voice is platform-specific

`TTS_PROVIDER=local` uses the operating system's TTS:

- **macOS** uses `say` — valid voices include `Samantha`, `Alex` (`say -v '?'` to list).
- **Linux** uses `espeak-ng` — use `en-us`.

The runner defaults to the right one per platform, but if you set `TTS_VOICE_ID`
explicitly it must be valid for the host OS or voice-input rows will fail to synthesize.
Use `TTS_PROVIDER=google` (with a key) for a platform-independent voice.

## `DEBUG` and BigQuery

- `DEBUG=false` (default): only **client-side** metrics are captured (behavior pass/fail
  and `ttfb` / `e2e` / `tts` latency). **No BigQuery needed.**
- `DEBUG=true`: core-service additionally emits per-turn `turn-trace` messages over the
  SDK data channel, giving **server-side per-stage latency (ASR/LLM/TTS) without
  BigQuery**. (A 5000-row/session BQ cap applies in this mode, irrelevant if you don't use BQ.)

In short: behavior scoring and client-side latency never need BQ. Server-side per-stage
latency is available BQ-free by setting `DEBUG=true`.

## Input format

The runner accepts the runtime-row **CSV** (the `docs/csv-adapter.md` columns) or a
**JSON array** of rows. For authored scenario JSON, convert first:

```bash
convai-evals convert scenario.json > rows.json
```

## Credentials & data hygiene

Pass `CHARACTER_ID` / `API_KEY` via the environment (or a local `.env` you do not commit).
Never hardcode keys in the script, and keep datasets outside the repo.
