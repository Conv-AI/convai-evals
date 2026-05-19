import type { CsvParseResult } from "../csv/CsvParser.js";

interface Props {
  filename: string;
  isSample: boolean;
  dataset: CsvParseResult;
  onUploadDifferent: () => void;
  onResetToSample: () => void;
}

export function DatasetDetail({
  filename,
  isSample,
  dataset,
  onUploadDifferent,
  onResetToSample,
}: Props): JSX.Element {
  const sessionRowCounts = countBySession(dataset.rows);
  const previewRows = dataset.rows.slice(0, 8);
  return (
    <div className="card stack-lg">
      <header className="dataset-header">
        <div>
          <h1>{isSample ? "Synthetic eval sample" : filename}</h1>
          <p className="muted">
            {isSample
              ? "Built-in sample covering text, voice, and dynamic-context rows across run_llm true/auto/false. Use this to validate the runner before pointing it at your own dataset."
              : `Uploaded CSV: ${filename}`}
          </p>
        </div>
        <div className="dataset-actions">
          <button onClick={onUploadDifferent}>Upload different CSV</button>
          {!isSample && (
            <button onClick={onResetToSample} className="primary-outline">
              Reset to synthetic sample
            </button>
          )}
        </div>
      </header>

      <section>
        <h2>Overview</h2>
        <div className="stat-row">
          <Stat label="Rows" value={dataset.rows.length.toString()} />
          <Stat label="Sessions" value={dataset.session_ids.length.toString()} />
          <Stat label="Voice In rows" value={dataset.voice_in_count.toString()} />
          <Stat label="Text In rows" value={dataset.text_in_count.toString()} />
          <Stat
            label="Dynamic Context rows"
            value={(dataset.rows.length - dataset.voice_in_count - dataset.text_in_count).toString()}
          />
        </div>
      </section>

      <section>
        <h2>Bucket distribution</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>bucket</th>
              <th style={{ textAlign: "right" }}>count</th>
              <th>description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>voice_in_true</code></td>
              <td style={{ textAlign: "right" }}>{dataset.bucket_counts.voice_in_true ?? 0}</td>
              <td>user_text_message via synthesized voice; bot should respond</td>
            </tr>
            <tr>
              <td><code>text_in_true</code></td>
              <td style={{ textAlign: "right" }}>{dataset.bucket_counts.text_in_true ?? 0}</td>
              <td>user_text_message sent directly as text (no TTS/STT); bot should respond</td>
            </tr>
            <tr>
              <td><code>dyn_true</code></td>
              <td style={{ textAlign: "right" }}>{dataset.bucket_counts.dyn_true ?? 0}</td>
              <td>context-update with run_llm=true; bot must respond</td>
            </tr>
            <tr>
              <td><code>dyn_auto</code></td>
              <td style={{ textAlign: "right" }}>{dataset.bucket_counts.dyn_auto ?? 0}</td>
              <td>context-update with run_llm=auto; bot decides</td>
            </tr>
            <tr>
              <td><code>dyn_false</code></td>
              <td style={{ textAlign: "right" }}>{dataset.bucket_counts.dyn_false ?? 0}</td>
              <td>context-update with run_llm=false; silent, no LLM</td>
            </tr>
            {(dataset.bucket_counts.other ?? 0) > 0 && (
              <tr>
                <td><code>other</code></td>
                <td style={{ textAlign: "right" }}>{dataset.bucket_counts.other}</td>
                <td>rows with missing/unknown run_llm</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Sessions ({dataset.session_ids.length})</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>session_id</th>
              <th style={{ textAlign: "right" }}>rows</th>
              <th style={{ textAlign: "right" }}>span (s)</th>
            </tr>
          </thead>
          <tbody>
            {dataset.session_ids.map((s) => {
              const info = sessionRowCounts[s];
              return (
                <tr key={s}>
                  <td><code>{s}</code></td>
                  <td style={{ textAlign: "right" }}>{info?.count ?? 0}</td>
                  <td style={{ textAlign: "right" }}>{info?.span?.toFixed(0) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Preview (first 8 rows)</h2>
        <div className="table-scroll">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th>test_id</th>
                <th>session_id</th>
                <th>seq</th>
                <th>t (s)</th>
                <th>kind</th>
                <th>expected</th>
                <th>input_text / context</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r) => (
                <tr key={r.test_id}>
                  <td><code>{r.test_id}</code></td>
                  <td><code>{r.session_id}</code></td>
                  <td style={{ textAlign: "right" }}>{r.sequence_index}</td>
                  <td style={{ textAlign: "right" }}>{r.timestamp_offset_s}</td>
                  <td>{r.input_kind}</td>
                  <td>{r.expected_response_behavior}</td>
                  <td className="truncate">{r.input_text ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dataset.rows.length > 8 && (
          <p className="muted small">… and {dataset.rows.length - 8} more rows.</p>
        )}
      </section>

      {dataset.warnings.length > 0 && (
        <section>
          <details>
            <summary>{dataset.warnings.length} warnings</summary>
            <pre>{dataset.warnings.join("\n")}</pre>
          </details>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

interface SessionInfo {
  count: number;
  span: number;
}

function countBySession(rows: Array<{ session_id: string; timestamp_offset_s: number }>): Record<string, SessionInfo> {
  const out: Record<string, { count: number; min: number; max: number }> = {};
  for (const r of rows) {
    const slot = out[r.session_id] ?? { count: 0, min: r.timestamp_offset_s, max: r.timestamp_offset_s };
    slot.count += 1;
    slot.min = Math.min(slot.min, r.timestamp_offset_s);
    slot.max = Math.max(slot.max, r.timestamp_offset_s);
    out[r.session_id] = slot;
  }
  const result: Record<string, SessionInfo> = {};
  for (const [s, v] of Object.entries(out)) {
    result[s] = { count: v.count, span: v.max - v.min };
  }
  return result;
}
