# Evidence provenance

- `preregistration.json` binds the experiment design to its SHA-256 before implementation and inference. Git commit `53939cb` records that freeze.
- `local-tests/vitest.json` is an actual local Vitest report. The transport tests run the official SDK against **mock HTTP**, not the OpenAI service. They are implementation checks, not nine experimental sessions.
- `runs/` contains generated manifests, original planned requests, installed-SDK audits, timestamped hash-linked local events and results. A blocked attempt's nine `trial.not-started` records are nine planned trials, not nine real runs.
- `route-review.example.json` is an unestablished annotation template. It is not an observation or a completed review.

The run manifest records SDK, Node and pnpm versions, model requested, protocol hash, source and lockfile hashes, implementation hashes, Git state and configured limits. Missing server version and model usage remain null. No claim about a server implementation version follows from an SDK version pin.

Recompute a run's classification with `pnpm replay evidence/runs/<directory>`. Log hashes detect changes within the recorded chain. They are not signatures, do not prove completeness outside that chain, and do not authenticate a human review. The public transcript cannot automatically certify the native programmatic route.

Full cached research pages are excluded from Git. `research/sources.json` identifies the URL, representation, retrieval metadata and hash of each local source artifact. Git sources are pinned by commit and SDK sources by package version. Source metadata reflects this review's retrieval, not a promise that mutable documentation remains unchanged.
