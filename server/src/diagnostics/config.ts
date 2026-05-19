export type DiagProvider = "none" | "analytics-api";

export interface DiagConfig {
  enabled: boolean;
  provider: DiagProvider;
  analyticsBaseUrl: string;
  apiKey?: string;
  rowConcurrency: number;
  fetchSuccessfulRows: boolean;
}

export function loadDiagConfig(): DiagConfig {
  const provider = normalizeProvider(process.env.DIAG_PROVIDER);
  return {
    enabled: provider !== "none",
    provider,
    analyticsBaseUrl:
      process.env.CONVAI_ANALYTICS_BASE_URL ?? "https://analytics-api.convai.com/v1/analytics",
    apiKey: process.env.CONVAI_API_KEY,
    rowConcurrency: Number(process.env.DIAG_ROW_CONCURRENCY ?? "4"),
    fetchSuccessfulRows: process.env.DIAG_FETCH_SUCCESSFUL_ROWS === "true",
  };
}

function normalizeProvider(raw: string | undefined): DiagProvider {
  if (raw === "analytics-api") return raw;
  return "none";
}
