import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import type { DiagnosticsSummary, PerRowResult } from "@convai/evals-shared";
import type { WorkerHandle } from "../orchestrator/WorkerHandle.js";
import type { DiagConfig } from "./config.js";
import type { AnalyticsApiResult, DiagnosticsBundle } from "./types.js";

export async function collectForRun(
  perRow: PerRowResult[],
  runId: string,
  _handles: WorkerHandle[],
  cfg: DiagConfig,
  diagnosticsDir: string,
): Promise<void> {
  if (!cfg.enabled || cfg.provider !== "analytics-api") return;

  const targets = cfg.fetchSuccessfulRows
    ? perRow
    : perRow.filter((r) => r.failure_reason !== "pass");

  if (targets.length === 0) return;
  await fs.mkdir(diagnosticsDir, { recursive: true });

  const limit = pLimit(cfg.rowConcurrency);
  await Promise.all(
    targets.map((row) =>
      limit(async () => {
        row.diagnostics = await collectForRow(row, runId, cfg, diagnosticsDir);
      }),
    ),
  );
}

async function collectForRow(
  row: PerRowResult,
  runId: string,
  cfg: DiagConfig,
  diagnosticsDir: string,
): Promise<DiagnosticsSummary> {
  const t0 = Date.now();
  const backendSessionId = row.backend?.session_id;
  const interactionId = row.backend?.character_session_id;
  const bundlePath = path.join(diagnosticsDir, `${sanitizeId(row.test_id)}.json`);

  if (!backendSessionId && !interactionId) {
    await writeBundle(bundlePath, skippedBundle(row, runId, "no_backend_ids", Date.now() - t0));
    return summary(bundlePath, 0, 0, "no_backend_ids");
  }

  if (!cfg.apiKey) {
    await writeBundle(bundlePath, skippedBundle(row, runId, "missing_convai_api_key", Date.now() - t0));
    return summary(bundlePath, 0, 0, "missing_convai_api_key");
  }

  const errors: string[] = [];
  const session = backendSessionId
    ? await fetchAnalytics(cfg, `/sessions/${encodeURIComponent(backendSessionId)}`)
    : undefined;
  const interaction = interactionId
    ? await fetchAnalytics(cfg, `/interactions/${encodeURIComponent(interactionId)}`)
    : undefined;

  for (const result of [session, interaction]) {
    if (result && !result.ok) errors.push(`${result.endpoint}: ${result.status} ${result.error ?? "request_failed"}`);
  }

  const bundle: DiagnosticsBundle = {
    test_id: row.test_id,
    run_id: runId,
    provider: "analytics-api",
    backend: {
      session_id: backendSessionId,
      character_session_id: interactionId,
      turn_id: row.backend?.turn_id,
      character_id: row.backend?.character_id,
    },
    failure_reason: row.failure_reason,
    analytics_api: {
      session,
      interaction,
      skipped: !session && !interaction ? "no_supported_backend_ids" : undefined,
    },
    fetch_meta: {
      fetch_duration_ms: Date.now() - t0,
      errors,
    },
  };
  await writeBundle(bundlePath, bundle);
  return summary(bundlePath, [session, interaction].filter(Boolean).length, errors.length, undefined, errors);
}

async function fetchAnalytics(cfg: DiagConfig, suffix: string): Promise<AnalyticsApiResult> {
  const base = cfg.analyticsBaseUrl.replace(/\/$/, "");
  const endpoint = `${base}${suffix}`;
  try {
    const res = await fetch(endpoint, {
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey ?? "",
        authorization: `Bearer ${cfg.apiKey ?? ""}`,
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Keep text body as-is.
    }
    return {
      endpoint,
      status: res.status,
      ok: res.ok,
      body,
      error: res.ok ? undefined : truncate(text, 400),
    };
  } catch (e) {
    return {
      endpoint,
      status: 0,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function skippedBundle(
  row: PerRowResult,
  runId: string,
  reason: string,
  fetchDurationMs: number,
): DiagnosticsBundle {
  return {
    test_id: row.test_id,
    run_id: runId,
    provider: "analytics-api",
    backend: {
      session_id: row.backend?.session_id,
      character_session_id: row.backend?.character_session_id,
      turn_id: row.backend?.turn_id,
      character_id: row.backend?.character_id,
    },
    failure_reason: row.failure_reason,
    analytics_api: { skipped: reason },
    fetch_meta: { fetch_duration_ms: fetchDurationMs, errors: [] },
  };
}

async function writeBundle(bundlePath: string, bundle: DiagnosticsBundle): Promise<void> {
  await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2));
}

function summary(
  bundlePath: string,
  itemCount: number,
  errorCount: number,
  skipped?: string,
  errors?: string[],
): DiagnosticsSummary {
  return {
    bundle_path: bundlePath,
    provider: "analytics-api",
    item_count: itemCount,
    warning_count: 0,
    error_count: errorCount,
    skipped,
    errors: errors?.length ? errors : undefined,
  };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 200);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
