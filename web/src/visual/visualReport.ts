import type { VisualReportPayload } from "./visualTypes.js";

const LOCAL_REPORT_KEY = "convai.visualLipsync.latestReport";

export async function saveVisualReport(report: VisualReportPayload): Promise<void> {
  const sanitized = sanitizeReport(report);
  localStorage.setItem(LOCAL_REPORT_KEY, JSON.stringify(sanitized));
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
  localStorage.setItem(LOCAL_REPORT_KEY, JSON.stringify(sanitizeReport(report)));
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
