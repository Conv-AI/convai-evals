import { REQUIRED_COLUMNS, OPTIONAL_COLUMNS, type CsvColumnSpec } from "@convai/evals-shared";

interface Props {
  onLoadSample?: () => void;
}

export function SchemaDoc({ onLoadSample }: Props = {}): JSX.Element {
  return (
    <div className="card stack-lg">
      <header>
        <h1>Get started</h1>
        <p className="muted">
          Upload a CSV table and the runner will replay each <code>session_id</code> as
          one SDK connection, firing rows at their relative timestamps. Voice In rows are synthesized
          into audio and streamed through a synthetic microphone (in headless Chromium); Text In rows
          send a <code>user_text_message</code> directly (no TTS/STT); Dynamic Context rows are sent
          via the SDK's <code>updateContext</code> API.
        </p>
        {onLoadSample && (
          <div style={{ marginTop: 12 }}>
            <button className="primary" onClick={onLoadSample}>
              Load synthetic sample
            </button>
          </div>
        )}
      </header>

      <section>
        <h2>Required columns</h2>
        <ColumnsTable cols={REQUIRED_COLUMNS} />
      </section>

      <section>
        <h2>Optional columns</h2>
        <ColumnsTable cols={OPTIONAL_COLUMNS} />
      </section>

      <section>
        <p>
          <a href="/sample-dataset.csv" download="sample-dataset.csv">
            Download the synthetic sample CSV
          </a>{" "}
          to see the format end-to-end.
        </p>
      </section>
    </div>
  );
}

function ColumnsTable({ cols }: { cols: readonly CsvColumnSpec[] }): JSX.Element {
  return (
    <div className="table-scroll">
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>description</th>
            <th>example</th>
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name}>
              <td>
                <code>{c.name}</code>
              </td>
              <td>
                {c.type}
                {c.enumValues ? ` (${c.enumValues.join(" | ")})` : ""}
              </td>
              <td>{c.description}</td>
              <td>{c.example ? <code>{c.example}</code> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
