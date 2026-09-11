# Evidence provenance

- `preregistration.json` binds the experiment design to its SHA-256 before implementation and inference. Git commit `53939cb` records that freeze.
- `preregistration-v2.json` records the authorized Luna/$2 stopping-budget amendment. `preregistration-v3.json` additionally binds the telemetry-lag correction and prior accounting. Earlier cohorts are retained separately.
- `preregistration-v4.json` binds the corrected two-child control and the reservation policy for delayed usage. Its nine-trial cohort is distinct from the two earlier one-trial calibration attempts.
- `local-tests/vitest.json` is an actual local Vitest report. The transport tests run the official SDK against **mock HTTP**, not the OpenAI service. They are implementation checks, not nine experimental sessions.
- `local-tests/vitest-v2.json` and `vitest-v3.json` record the expanded budget and cancellation checks. Real service observations are under `runs/`, not in these test reports.
- `local-tests/vitest-v4.json` records 31 passing local tests before the final cohort. `replay-v4.json` records the conservative inconclusive classification after all nine trials were collected.
- `runs/` contains generated manifests, original planned requests, installed-SDK audits, timestamped hash-linked local events and results. A blocked attempt's nine `trial.not-started` records are nine planned trials, not nine real runs.
- September 11 UTC live attempt directories contain actual session IDs, SSE and function records. Timestamped `reconcile-*` subdirectories contain read-only follow-up observations. They do not overwrite an earlier null usage field or turn an interrupted trial into a success.
- The final cohort's `analysis.json` is derived by `pnpm analyze`; it links exact-answer checks and wait records to source-log hashes and sequence numbers. It does not certify the missing program-to-child caller relationship.
- `route-review.example.json` is an unestablished annotation template. It is not an observation or a completed review.

The run manifest records SDK, Node and pnpm versions, model requested, protocol hash, source and lockfile hashes, implementation hashes, Git state and configured limits. Missing server version and model usage remain null. No claim about a server implementation version follows from an SDK version pin.

Budget estimates can be partial when individual turns have null usage. Do not treat a sum of known counts as the total bill. The later `allObservedTurnsHaveUsage` field makes that distinction explicit, and even complete recorded counts remain best-effort provider accounting.

Recompute a run's classification with `pnpm replay evidence/runs/<directory>`. Log hashes detect changes within the recorded chain. They are not signatures, do not prove completeness outside that chain, and do not authenticate a human review. The public transcript cannot automatically certify the native programmatic route.

Full cached research pages are excluded from Git. `research/sources.json` identifies the URL, representation, retrieval metadata and hash of each local source artifact. Git sources are pinned by commit and SDK sources by package version. Source metadata reflects this review's retrieval, not a promise that mutable documentation remains unchanged.
