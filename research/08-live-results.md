# Live results: Luna with a USD 2 stopping budget

**The native-from-code prompt did not reliably collect both child results. This is a negative result for the tested workflow, but the API capability question remains inconclusive.** We have no verified runtime rejection showing that native delegation is unavailable inside generated code, and the public records do not certify that caller relationship.

OpenCnid authorized `gpt-5.6-luna` and a USD 2 stopping threshold with possible overshoot. All live requests used the official SDK pinned to 7.15.0. We retained every calibration attempt and registered each change before its next cohort. No failing native prompt was rewritten during the final matrix.

## What we observed

The [final matrix](../evidence/runs/2026-09-11T00-34-37-740Z-run-fa6155a8/manifest.json) uses three arms across three rotated blocks. Each session receives fresh synthetic tasks. Answer correctness and execution-route attribution are separate.

| Arm | Exact submissions | Completed native children | Interpretation limit |
| --- | --- | --- | --- |
| Direct native delegation | 2 of 3 | Two in each trial | The third control failed because a child's returned string was incorrect. |
| Code without delegation | 3 of 3 | None | Correct output does not independently prove execution inside a program. |
| Native delegation requested from code | 0 of 3 | Two in each trial | Child creation worked; a complete pair of answers was not submitted. |

All three native-from-code failures have a concrete signature in the service records: the initial wait item names two child IDs, while the completed wait item names one. Each submitted pair includes `undefined` or `ERROR: undefined` for the missing child. Later child histories contain completed answers. The first two pairs of child answers were correct; in the third trial, the missing child's eventual answer was also incorrect. These observations are stronger than the model's explanation but do not expose the executing JavaScript or prove its caller edges.

In the two successful direct-delegation controls, the records instead show two completed waits, one for each child's result. The third direct control also collected both results but reproduced one child's incorrect reversal. That task error is separate from the native-from-code collection failure. This tiny synthetic task is therefore not a pure transport test; model errors are a real confound.

All nine root turns completed, all histories were collected, and all twelve child turns completed. Five of nine submissions were exact. These counts describe the final v4 cohort only. The [derived analysis](../evidence/runs/2026-09-11T00-34-37-740Z-run-fa6155a8/analysis.json) contains each expected value, actual submission, child answer, wait item, source-log hash and sequence number. [Raw run result](../evidence/runs/2026-09-11T00-34-37-740Z-run-fa6155a8/result.json).

Replay verified the evidence and returned `inconclusive`, reason `INSUFFICIENT_ROUTE_OR_CONTROL_EVIDENCE`. Zero of three correct native submissions is a workflow failure; it does not satisfy the preregistered criterion of repeated verified runtime unavailability. The unreviewed routes and failed third-block control also prevent a supported classification. [Replay output](../evidence/local-tests/replay-v4.json).

The managed API documentation explicitly warns that a completed create or wait action is not proof that the child has finished its task. [Multi-agent lifecycle](https://developers.openai.com/api/docs/guides/agents-api/multi-agent). Our interpretation is that the workflow treated a partial wait result as sufficient for submission. This is a result-collection failure, not evidence that recursive calls are categorically forbidden.

## Why the earlier attempts are retained

| Cohort | Observation | Change registered before the next cohort |
| --- | --- | --- |
| v2 | Usage remained null for thirty seconds, so the client cancelled the first control. Follow-up records showed cancelled root and child turns with usage. | Removed the unsupported thirty-second accounting expectation; kept the 120-second deadline. |
| v3 | The first control returned an incorrect submission. One child creation completed and another failed under a one-active-child setting. Root usage was missing after completion and arrived in a later read. | Allowed two active children, matching the task, and reserved the full trial allowance while usage was missing. |
| v4 | Separate final matrix, with fixed prompts and grading. | No prompt or task changes during this matrix. |

The v3 model said both child calls were blocked, but the records show one completed child. This is an observed example of why self-report is insufficient. We infer that the configured concurrency limit caused the second creation failure; the public failed-call item does not itself expose the underlying error text.

These are calibration corrections, including mistakes in our initial probe design. They are not nine independent repetitions of one unchanged protocol, and they are not pooled with the final matrix. The [Luna budget amendment](05-luna-two-dollar-protocol.md), [usage-lag correction](06-usage-lag-amendment.md), and [control/accounting correction](07-control-and-accounting-amendment.md) record the changes and bind earlier evidence by hash.

## Spending and lifecycle

The guard checks reported usage every ten seconds and on streamed turn events, requests cancellation at USD 0.20 per trial or USD 2 across the study, and retains a 120-second trial deadline. While usage is missing, the full USD 0.20 reservation counts against further admission. Cached input is not discounted in the conservative estimate. Reasoning is counted within output once.

The final cohort began with USD 0.054622 carried from the two earlier attempts. Nine additional reservations plus that amount total USD 1.854622. Reservations are not proof of billed cost: reporting and cancellation can lag, and the operator explicitly accepted overshoot. Follow-up usage snapshots are retained separately from the observations made while the run was active.

The runner made eleven paid session-creation requests in total: one in v2, one in v3 and nine in v4. No SDK retry or replacement trial occurred inside a cohort. The last v4 in-run estimate was USD 0.2354548 including prior accounting, but six root turns still lacked usage; that number is explicitly partial, not the total cost. The guard counted USD 1.3248737 against admission after reserving the unresolved usage. No spending threshold was reached during the final matrix.

Read-only reconciliation subsequently found usage for all observed turns, zero pending actions, and all nine sessions idle with completed root and child turns. The combined conservative estimate became **USD 0.3673506**, including the earlier USD 0.054622. This is below the agreed USD 2 stopping threshold, but it is not a verified final bill. [Late usage and lifecycle evidence](../evidence/runs/2026-09-11T00-34-37-740Z-run-fa6155a8/reconcile-2026-09-11T00-43-58-451Z/result.json).

Accounting itself has a near miss: in the third direct control, the root's recorded counts rose from 78,405 input / 796 output to 91,643 input / 1,288 output. The increase exactly matches the separately recorded child counts of 13,238 input / 492 output. This is consistent with a later descendant rollup, but the records do not label it as such. Summing root and child turns may therefore overcount. Our guard intentionally uses conservative rates and counting; these figures should not be used as an exact cost comparison between harnesses.

The implementation passed TypeScript checks and 31 local tests before the final cohort. Those tests used mock transport; the session IDs, tool calls and submissions above are from the actual service. [Local test report](../evidence/local-tests/vitest-v4.json).

## What this changes about our decision

Our reading that exact external state can coexist with managed compaction still stands. The live evidence adds a practical requirement: an RLM adapter must collect every requested child result explicitly. A completed wait action cannot be used as a substitute for a join over all requested children.

The current prompt/workflow is not ready to claim faithful RLM behavior. A next experiment should implement or require an explicit pending-child loop, capture the executed program and native-call/result relationships, and retain the same exact-answer oracle. That would be a new protocol, not a reinterpretation of these failures.

The detailed trace dashboard required a browser login, which was not available during this inspection. We therefore retain route attribution as **unestablished**. We do not use child IDs, `exec-` prefixes, enabled PTC settings, or the model's assertion that it ran one program as substitutes for the missing trace evidence. [Dashboard access observation](../evidence/dashboard-access.json).

This study does not test compaction survival, long-context scaling, parent-context admission, or production reliability. Those remain separate from this finite coordination probe. The [original source review](01-reading.md) and [pre-live result](04-results.md) remain available with their historical limitations intact.
