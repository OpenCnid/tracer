# Results and decision

**The scientific result is inconclusive.** The native programmatic delegation hypothesis has neither passed nor failed. This repository contains the independent reading, frozen design, implemented collector and local verification evidence. The requested repeated real-session evidence is still missing.

My answer to the broader decision is conditional: **RLM-style inference can coexist with context management owned by a vendor. That does not establish a faithful native port or a cheaper operational boundary.** Exact external objects and a usable programmatic recursive interface matter more than ownership of the root compactor. I would not retire the existing harness on the evidence obtained here.

## Observed

The following are observations from source inspection or local execution. None is a measured behavior of a real Agents API session.

| Observation | Evidence |
| --- | --- |
| The design was frozen before implementation/inference. | [Preregistration](../evidence/preregistration.json), Git commit `53939cb`. |
| Installed official SDK is exactly `openai@7.15.0`. | [Installed-source audit](../evidence/runs/2026-09-10T23-26-17-732Z-run-268e83ab/sdk-audit.json). |
| The inspected session-create, agent and session-update fields contain no configurable token, model-step or session-spend budget. The SDK does contain `session_budget_exceeded`. | The same audit retains the actual property lists and source hashes. It does not establish the absence of undocumented server limits. |
| Local execution used Node `v24.19.0` and pnpm `11.7.0`; the requested model was `gpt-6-astra`. | [Run manifest](../evidence/runs/2026-09-10T23-26-17-732Z-run-268e83ab/manifest.json). The model was never contacted. |
| TypeScript checks passed and all 22 local tests passed. | [Validation command outputs](../evidence/local-tests/validation.json), [Vitest report](../evidence/local-tests/vitest.json). SDK transport tests used synthetic HTTP/SSE responses. |
| One plan and one blocked study attempt were executed. The attempt planned nine trials, started zero and completed zero. | [Plan](../evidence/runs/2026-09-10T23-26-12-521Z-plan-d65cc1fc/result.json), [attempt result](../evidence/runs/2026-09-10T23-26-17-732Z-run-268e83ab/result.json), [ten local event records](../evidence/runs/2026-09-10T23-26-17-732Z-run-268e83ab/events.jsonl). |
| The attempt recorded both `MISSING_OPENAI_API_KEY` and `HARD_SPEND_BOUND_UNAVAILABLE`. | Attempt result above. Its manifest records credential presence only; no credential is published. |
| No paid inference or read-only service requests were dispatched by the study. Observed model usage and server version are null. | Attempt result and manifest. Nine `trial.not-started` entries are not independent experimental runs. |
| Replay verified ten hash-linked records, found zero collected trials, and returned `inconclusive`, reason `INCOMPLETE_OR_REUSED_SESSIONS`. | [Replay output](../evidence/local-tests/replay.json). Reproduce with `pnpm replay evidence/runs/2026-09-10T23-26-17-732Z-run-268e83ab`. Here that broad reason means incomplete, not that any session was reused. |

The CLI reported exit code 2 for the blocked attempt. The surrounding `npx pnpm` lifecycle wrapper returned 1 and printed the underlying code 2. Neither is a successful experiment. This distinction matters when reproducing the command in automation.

The local tests cover exact grading, changed duplicate calls, admission and byte limits, request cleanup reserves, pagination bounds, tamper detection, refusal to classify unreviewed answers, mixed beta outcomes, missing controls, and official-SDK SSE handling. They also exercise cancellation after a silent-stream deadline and after the evidence log reaches its cap. They do not prove remote cancellation, actual native-call availability, compaction behavior or production reliability.

## Inferred

There is a **documented-contract negative**: I cannot establish the frozen study's strict USD 5 ceiling from the inspected public controls. Project hard limits allow delayed enforcement and overshoot without a stated finite maximum; client cancellation and observed usage cannot replace that admission-time guarantee. This explains why the gate refuses dispatch. It is not an observed overspend, an access denial, or proof that the provider has no internal budget mechanism. [OpenAI spend-limit contract](https://developers.openai.com/api/docs/guides/spend-limits).

The strict dollar ceiling and refusal of unbounded overshoot are this reviewer's conservative operationalization of the brief's hard-cap requirement. If the team intended a different spending contract, it should be stated explicitly and preregistered as a new cohort. The current implementation does not quietly reinterpret that constraint to obtain a run.

The literature and reference code support compatibility between external exact state and lossy working history. The native programmatic interface remains a contract gap. An application tool could bridge to independent leaf sessions, but that transfers lineage, cancellation, admission and result-delivery work back to the application. Consequently, “RLM is possible” is weaker than “this migration removes our harness maintenance.” See the [reading and citations](01-reading.md).

The selected probe deliberately does not test compaction survival. Even a future positive result would establish only finite native delegation from generated code. It would not establish bounded child-output admission, empty child context, state survival, economic improvement, or safe replacement of the existing runtime. The [frozen follow-on designs](02-preregistered-probe.md#follow-on-tests-outside-this-implementation) address those questions separately.

## What would make this conclusive

1. Configure a valid API credential locally and establish Agents API inference access. Creating a repository or an empty `.env` cannot create that credential.
2. Establish a documented finite spending bound covering root work, descendants and internal recovery, then implement its admission checks under a new reviewed protocol. Alternatively, explicitly agree a different spending contract and register that changed assumption; do not relabel the present contract as satisfied.
3. Execute all nine fresh sessions without prompt tuning or replacement of unsuccessful trials. Preserve failures, usage uncertainty and model/schema changes. A beta change starts a separate cohort.
4. Retain independent generation/tool evidence sufficient to establish the actual program-to-child calls and returned values. If the available traces cannot show that relationship, the native interface remains inconclusive even with correct answers.

Three controlled positive native trials would support this finite interface. At least two matching verified runtime rejections with working controls would reject the native route for the tested cohort. A mixture cannot sustain a blanket claim of unavailability. These criteria were fixed before implementation and have not been changed to fit the blocked result.

The practical decision now is to preserve the existing harness while investigating a managed adapter. Do not reject the direction merely because the compactor is managed, and do not claim a migration is validated by the evidence in this repository.
