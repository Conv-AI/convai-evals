import type { VisualReportPayload } from "./visualTypes.js";

const LOCAL_REPORT_KEY = "convai.visualLipsync.latestReport";

export async function saveVisualReport(report: VisualReportPayload): Promise<void> {
  const sanitized = sanitizeReport(report);
  // Stash a slim copy locally for quick reload; the full report goes to the server,
  // where 20-turn payloads (snapshots + samples + debug events) easily exceed
  // localStorage's ~5 MB quota.
  saveLocalSlim(sanitized);
  const resp = await fetch("/api/visual-lipsync/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sanitized),
  });
  if (!resp.ok) {
    throw new Error(`failed to save visual report: ${await resp.text()}`);
  }
}

export function saveVisualReportLocal(report: VisualReportPayload): void {
  saveLocalSlim(sanitizeReport(report));
}

function saveLocalSlim(report: VisualReportPayload): void {
  // Drop the heavy per-sample / per-event / image-data fields before stashing.
  const slim: VisualReportPayload = {
    ...report,
    currentTurn: report.currentTurn
      ? {
          ...report.currentTurn,
          samples: [],
          debugEvents: report.currentTurn.debugEvents.slice(-40),
          snapshots: [],
        }
      : null,
    results: report.results.map((r) => ({
      ...r,
      samples: [],
      debugEvents: r.debugEvents.slice(-40),
      snapshots: [],
    })),
  };
  try {
    localStorage.setItem(LOCAL_REPORT_KEY, JSON.stringify(slim));
  } catch {
    // localStorage quota or privacy-mode errors are non-fatal: the server has the
    // full report and the UI uses in-memory state for the live view.
  }
}

function sanitizeReport(report: VisualReportPayload): VisualReportPayload {
  return {
    ...report,
    config: {
      ...report.config,
      characterId: report.config.characterId ? mask(report.config.characterId) : "",
    },
  };
}

function mask(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
