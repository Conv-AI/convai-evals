# Contributing

Thank you for improving Convai Evals.

Before opening a pull request, run:

```bash
npm install
npm run build
npm run validate:examples
```

Keep the public schema dataset-agnostic. Customer-specific columns should be mapped into `metadata`, and public examples must use synthetic content only.

Prefer JSON report output as the source of truth. HTML, CSV, and other formats should be derived from the machine-readable report.

Diagnostics must remain opt-in and should use public Convai APIs by default. Do not add cloud-project defaults, credentials, or private observability paths to this repo.
