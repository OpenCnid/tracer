# Probe preregistration

This design is frozen before probe implementation or inference. Its SHA-256 is recorded in `evidence/preregistration.json`. Later changes require a new protocol identifier, reasons and a separate cohort; failed attempts remain in evidence.

## Selected unknown

**Can a model-generated program call native managed subagents on programmatically constructed inputs and consume their returned values in code?**

This is the first load-bearing unknown for a native managed port, not a universal impossibility test for every RLM implementation. My hypothesis is that the managed surface can support this seam, but the docs' general statement about existing tools does not settle native delegation. A verified failure would reject the native route and my optimistic reading of that statement. An application-owned bridge could remain viable, at the price of a different ownership boundary.

I chose this ahead of compaction survival because a perfect compactor cannot supply a missing recursive call interface. I rejected persistent state as first unknown because application storage can supply it; rejected end-task accuracy because it conflates model and harness; and deferred efficiency, inherited context, automatic child-text admission, and cancellation to subsequent tests. Spending control and telemetry are gates on running and interpreting this experiment, even though they are not the selected scientific unknown.

## Three arms, three independent blocks

Protocol `native-seam-v1` has nine fresh sessions. Each block rotates the three arm orders. No adaptive prompt changes and no replacement of an unsuccessful session. Use one selected model string, one SDK pin and one service tier. A model or schema change starts a new cohort. A server implementation version may be unavailable; record that as unknown.

Each trial has two synthetic tasks created from random run-local nonces. The external fixture function is the only way to obtain them. Each task supplies a key, a nonce and a simple requested transformation: reverse the nonce exactly, preserving case. The application knows the oracle. The prompt contains no nonce or oracle. No private user data is used.

| Arm | Behavior required | Purpose |
| --- | --- | --- |
| `direct-native` | Fetch fixture; invoke two native children directly; collect transformed strings; submit results. PTC disabled. | Native children and tiny tasks work without programmatic orchestration. |
| `programmatic-local` | A generated program fetches the fixture, loops over tasks, reverses strings locally, and submits results from code. Delegation disabled. | PTC, fixture transfer, loops and result transport work without recursion. |
| `programmatic-native` | A generated program fetches fixture, loops over tasks, constructs native child prompts, awaits/collects native results, and submits results from code. | The selected seam. |

The native arm must use actual children registered in the **same session**. A shell script calling another model API, an application-created independent session, manual root calculation, or two root-level verbalized child calls does not satisfy it. Tool signatures must come from the actual runtime. The prompt asks for a bounded unsupported report if the needed capability cannot be used, without inventing a tool name.

The fixture and submit functions are root tools. Children do not need function tools: their task is entirely in their assigned text. Each submit must contain exactly the two expected keys and exact oracle values; duplicates, omissions, stale nonces and extra rows fail task correctness. Application functions are idempotent by session/turn/call ID. A duplicate with changed arguments is a protocol error.

## Evidence and classification

The collector retains the original requests, timestamped SSE events, every page of root and child items and turns, function requests/results, lifecycle errors, usage snapshots and cleanup outcomes. Run manifests include Node, pnpm and SDK versions, lockfile hash, protocol hash, model, limits, random seed, and source hashes. All data are synthetic; credentials and authorization headers are never logged.

**Task correctness** and **execution-route attribution** are separate fields. Correct strings and two native-child IDs prove neither that code launched the children nor that their outputs bypassed root inference. The reviewed public item types do not promise a PTC program-to-child caller edge. The runner must therefore leave route attribution `unestablished` unless independently reviewed generation/tool evidence identifies the executing program and its actual native calls/results.

Use the documented tracing dashboard when the public transcript lacks those edges. A reviewer records exact session/turn/span identifiers, the evidence artifact hash, and what was visible. An assistant's final JSON, a saved script that might not have run, or a function report saying “unsupported” is not independent route evidence. The evidence must show an actual runtime rejection or actual native invocation, not merely code the model proposed. The implementation deliberately does not auto-promote a self-report into this evidence.

Preregistered outcomes:

- **Supported at this seam:** all three blocks have valid positive controls, exact native-arm results, two completed native children, and independent evidence that the native invocations and result consumption occurred inside a generated program. This supports only the finite tested operation.
- **Refuted for this native route:** at least two independent native-arm trials show the same execution-level rejection/unavailability of native delegation inside a program, while their direct-native and programmatic-local controls work. Neither a model's assertion nor failure to choose the desired route qualifies.
- **Inconclusive:** anything else, including missing credentials, missing spend bounds, access denial, unknown routes, missing telemetry, a single rejection, inconsistent beta behavior, timeout, malformed output, control failure or incomplete lifecycle.

One complete execution with native calls inside code falsifies an absolute claim that the capability is unavailable. A mixed cohort must retain both successes and failures, and cannot support a blanket prohibition. Conversely, two verified runtime rejections with working controls falsify the optimistic native-route hypothesis for this cohort.

Three blocks are an integration smoke study, not a reliable failure-rate estimate or a production SLO. Even nine passing sessions would not show robustness over model or service updates.

## Near misses

| Apparent finding | Alternative explanation | Required discrimination |
| --- | --- | --- |
| Correct native-arm answer | Root computed locally or delegated outside code | Native child records plus executing program/caller evidence. |
| “Tool unavailable” | Model guessed an incorrect name or declined the route | Runtime/tool inventory evidence and a valid attempted call. |
| Program fails | Fixture parsing or transport is broken | Programmatic-local control and exact function ledger. |
| Child fails | Ordinary delegation is unavailable or model lacks capability | Direct-native control. |
| Two child results appear | A wait/create action completed, not child work | Child turns and exact result verification. |
| Session idle / stream ended | Failed, cancelled, waiting, or disconnected work | Explicit terminal turn outcome and saved-state reconciliation. |
| Missing old event | Non-replaying stream rather than lost state | Paginated persisted records; route remains unknown if unrecoverable. |
| Low usage | Late/missing usage or cache effects | Preserve nulls and later snapshots; no inference from zero defaults. |
| Repeat pass | Same session, stale submission, reused nonce, or retries hidden by SDK | Fresh IDs/nonces, default SDK retries disabled, retain all attempts. |
| Program emits only metadata | Harness may still admit child messages elsewhere | Follow-on admission study; this probe cannot prove exclusion. |
| Work resumes | No compaction ever happened | Require a real boundary for a later survival study. |

## Budget contract and execution gate

Hard local limits: nine session admissions, two children requested per native trial, two application tool executions per trial, 16 KiB aggregate function-output admission per trial, bounded HTTP calls/pages/events, and a 120-second trial deadline. Total child creation is observed, not enforced by the native concurrency setting. These bounds alone do **not** cap internal model work or charges.

The live runner must reject paid session creation if it cannot establish a finite server-enforced bound covering all root and child inference, retries, and compaction. No `max_tokens` field may be invented. No prompt instruction, client timeout, SSE disconnect, estimated-token counter, or cancellation acknowledgment is a substitute for an admission-time spending bound.

The planned study allocation is at most USD 5 in total, reserved before dispatch, with a maximum USD 0.50 per session (nine reservations = USD 4.50). This is an allocation, not a claim that the current service offers that control. The pinned public creation schema has no configurable session budget. A `session_budget_exceeded` error enum does not specify a customer-settable cap. Project hard limits are documented to permit overshoot, without a numerical maximum, so they do not establish this strict ceiling either. [Spend limits](https://developers.openai.com/api/docs/guides/spend-limits).

Until a documented enforceable bound is available, the runner emits the requests and an inconclusive gate result, and sends **zero paid inference requests**. There is no unchecked CLI override. A different accepted spending contract would require an explicit new protocol, not a quiet relaxation after seeing a failure.

## Follow-on tests, outside this implementation

If the native seam is supported, next vary external input and child-output sizes at fixed call count, measure parent admission with generation-level evidence, and use exact full-data digests to detect pre-program truncation. Canary recall is only positive leakage evidence; inability to recall is not proof of exclusion. Include head/middle/tail placements and directly admitted controls.

Then test continuation across an **observed** managed compaction boundary using a durable manifest, externally stored exact intermediate values, committed task IDs, and a post-boundary query whose selected target was not announced earlier. Compare paired no-compaction continuations. Track locator loss, data loss, tool unavailability and duplicate execution separately. Exhausting a fixed inflation allowance without witnessing compaction is inconclusive. Neither synthetic filler nor a Responses `/compact` call can certify an Agents API compaction test.
