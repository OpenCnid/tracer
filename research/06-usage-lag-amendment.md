# Usage-lag correction before a separate cohort

Cohort `native-seam-v2` stopped its first control when all reported usage remained null after thirty seconds. Read-only reconciliation later showed cancelled root and child turns with usable usage. The conservative estimate was USD 0.0248406. Native recursion was not tested by that interrupted control. We retain the attempt and its failure records.

This was a measurement assumption we imposed, not an API guarantee: the official [usage documentation](https://developers.openai.com/api/docs/guides/agents-api/observability#understand-token-usage) explicitly allows delayed or missing counts. A thirty-second missing-usage stop can interrupt valid work before accounting arrives.

Separate cohort `native-seam-v3` changes only the usage-monitoring grace policy. It does not replace the earlier trial inside its cohort. The task prompts, nonce generation, arm order, child concurrency, grading, SDK and model remain unchanged. No result from v2 is pooled with the new nine-trial matrix.

- Remove the thirty-second missing-usage cancellation. The existing 120-second deadline still applies to every trial, including when live usage is null.
- Continue polling every ten seconds and cancel at the USD 0.20 per-trial or USD 2 combined-study reported-usage threshold, or on telemetry errors or observed model changes.
- Require usable final root/child usage before admitting another paid session. A trial with unresolved final usage or incomplete history still stops this cohort. Do not retry or replace unsuccessful trials.
- Carry USD 0.0248406 from the earlier attempt into the new guard's starting estimate. The USD 2 threshold covers both attempts together. Report subsequent snapshots as estimates; late billing revisions and cancellation lag can still cause the overshoot OpenCnid accepted.
- Preserve every live event and error. A control failure remains a control failure; removing the unsupported timing assumption cannot establish the native programmatic route by itself.

The prior estimate comes from `evidence/runs/2026-09-11T00-23-15-958Z-run-2424a128/reconcile-2026-09-11T00-25-28-815Z/result.json`. Its hash is included in this cohort's preregistration alongside the three protocol documents. Read-only reconciliation is not a replacement inference run.
