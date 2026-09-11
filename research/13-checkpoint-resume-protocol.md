# Recover a task in a fresh managed Agents session

OpenCnid will test whether application-owned checkpoints allow a new managed Agents session to resume work without the old conversation. This follows the positive Responses compaction result. It does **not** observe, trigger or certify the managed harness's automatic compaction.

The protocol is frozen before inference. Keep `gpt-5.6-luna`, `openai@7.15.0`, Node and pnpm unchanged. No replacement trials, model changes or prompt repair after observing results.

## Three independent tasks, nine sessions at most

Each task has an immutable external file containing 512 random 2,048-character records and three jobs over distinct record indices. Job IDs and the task handle are random. Processing a job is an application function: read its exact source record, compute SHA-256, generate a random receipt, and save one result file. This is a small, observable local operation, not a model-computation or RLM benchmark. The result file is the operation's effect; do not generalize its guarantees to a remote transaction.

1. **Setup session:** call `current_task_state()` and process only the first pending job. Stop after that one job. The application verifies completion, then freezes a checkpoint containing the task/source hashes and hashes of all completed results.
2. **Bound fresh session:** create an entirely new Agents session. Its input says to recover and finish its assigned task; it contains no old session ID, task ID, handle, job IDs, results or transcript. The application durably binds this new session ID to the task. Reopen the task from disk in a new store object. `current_task_state()` takes no arguments and resolves only this server-side binding. It returns the handle, job statuses and saved completed results. The agent must process only the two pending jobs and submit a report identifying previously completed jobs, newly processed jobs and all exact result digests/receipts.
3. **Unbound fresh control:** create another new session with the same resume instructions and tools, but no task binding. Its state tool returns `unbound` without any task data. It must submit a blocked report and make no processing attempts. This tests the binding's role and guards against apparent recovery from leaked task context.

Alternate fresh-session order across tasks: bound/unbound, unbound/bound, bound/unbound. The unbound control never receives a clone or copy of the task. All model loops run on the managed Agents API. Use `environment:none`, ordinary application function tools, programmatic tool calling disabled and native children disabled. These choices isolate state recovery from the earlier delegation and program-attribution questions.

## What the adapter must guarantee locally

The session binding is derived from the session created by the runner, never from model-supplied task identity. Lookups cannot enumerate other tasks. Task handles and job IDs are validated against that bound task before any file access or operation.

Persist function results by session/turn/call ID. Re-delivery of the same call reuses its saved output and does not count as a new model attempt; changed arguments under the same call ID are rejected. A new call requesting an already completed job returns its saved result without executing the operation again, and is counted as a **duplicate attempt**. A prevented duplicate is not evidence that the model avoided repetition.

Freeze and verify the original completed result hash across handoff. Reject modified source/task/checkpoint state. Missing bindings return no data. Do not repair wrong handles, infer missing job IDs, copy an old transcript into the new session or silently mark incomplete jobs completed.

## Falsifiable outcomes

Measure independently: new session identity, absence of task data from its initial request, durable binding, manifest retrieval, exact old-result preservation, selection of pending jobs, operation counts, duplicate attempts, report accuracy, terminal state and spending.

A bound recovery passes only when setup was valid; the fresh session uses the bound checkpoint; the original completed result is unchanged; each previously pending job executes once; no completed job is requested again; and the final report exactly identifies old/new work and all results. Any completed, interpretable bound workflow that violates those conditions is a negative result for this adapter workflow. Report whether the failure was task discovery, job selection, duplication, missing work or result reporting.

The unbound control passes only if it explicitly reports blocked with empty job/result arrays and makes no processing attempt. If it reports completion or accesses task data, investigate control/isolation failure; do not claim the cohort establishes recovery. API errors, cancellation, missing setup, damaged checkpoint, missing evidence or incomplete service lifecycle make the affected inference inconclusive. Local fault-injection tests validate fail-closed storage and duplicate prevention; they are not paid model observations.

Support for the fixed cohort requires all three bound recoveries and all three unbound controls to pass. Individual results are retained even if the cohort is incomplete. This tests recovery across a deliberate conversation reset, not compaction, native recursion, arbitrary checkpoint quality, concurrent workers, or crash-atomic remote effects.

## Budget and evidence

Use a new shared **USD 2 reported-usage stopping threshold**, with possible overshoot accepted by OpenCnid. Maximum nine fresh sessions: three setup sessions at USD 0.20 each, three bound resumes at USD 0.25 each, and three unbound controls at USD 0.10 each. Reserve before dispatch, carry forward conservative estimates/reservations, and refuse a reservation that does not fit. No invocation may reset the same allowance: write an exclusive study dispatch claim before inference.

Reuse ten-second usage checks, 120-second turn deadlines, explicit cancellation on collection errors, 40 HTTP requests per session including cleanup reserve, 2,000 stream events, 12 pagination pages and 8 MiB event-log cap per session. The task ledger permits at most six new function calls and 16 KiB total tool output per session. No paid external tools or concurrent sessions. Disable SDK retries. Price reported input at USD 0.50/M and output at USD 1.80/M, ignoring cache discounts; estimates are not invoices. Missing usage retains the session reservation. Stop new inference on API/collector failures; do not assume an unidentified or cancelled session stopped billing. Finish with read-only reconciliation of this study's own sessions.

Persist protocol, SDK/source/lockfile hashes, initial requests, raw events, server-side bindings, original files, checkpoint, per-call results, job effects, reports, classifications and reconciled usage. Local tests must establish binding isolation, clean new-session input, storage-integrity rejection, recovery from disk, exact report checks, duplicate prevention and recording, and positive/negative/inconclusive scoring. Existing paid transport/budget tests remain applicable.

## Source basis

- [Managed function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions) support application-owned functions and recommend durable call-result storage for recovery.
- [Sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions) distinguish creating a session from continuing an existing one.
- [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture) keeps the harness managed even when application tools own exact state.
- [Our Responses result](12-responses-compaction-results.md) motivates the small-locator design, but is not evidence of managed Agents compaction behavior.
