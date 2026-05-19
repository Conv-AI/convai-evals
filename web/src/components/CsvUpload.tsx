interface Props {
  hasDataset: boolean;
  onTriggerUpload: () => void;
  onLoadSample: () => void;
  error: string | null;
}

export function CsvUpload({ hasDataset, onTriggerUpload, onLoadSample, error }: Props): JSX.Element {
  return (
    <div className="card">
      <h2>Dataset</h2>
      <p className="muted small">
        Upload a CSV table or load the built-in synthetic sample to validate the pipeline.
      </p>
      <div className="stack-sm">
        <button type="button" className="primary-outline" onClick={onTriggerUpload}>
          Upload CSV
        </button>
        <button type="button" className="ghost" onClick={onLoadSample}>
          {hasDataset ? "Reset to synthetic sample" : "Load synthetic sample"}
        </button>
      </div>
      {error && <pre className="error-text small">{error}</pre>}
    </div>
  );
}
