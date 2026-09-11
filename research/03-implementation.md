# Implementation

The implementation uses TypeScript, pnpm 11.7.0, the official `openai` SDK pinned to 7.15.0, and Vitest 4.1.8. The Node engine matches the requested `^22.19.0 || >=24.0.0`. TypeScript, tsx and Node typings match the examined DeepSeek RLM package versions. The dependency lockfile is committed. The current cohort requests `gpt-5.6-luna`.

The code generates frozen trials, enforces admission gates, collects raw evidence through the official API surface, and scores independently reviewed evidence. The follow-up also provides an immutable external file through function tools. OpenAI continues to own the model loop; this is not a persistent RLM product.

| File | Role |
| --- | --- |
| `src/protocol.ts` | Nine-trial matrix, independent deterministic fixtures, exact oracle, three request arms. |
| `src/sdk-audit.ts` | Actual SDK version, source hashes, AST-derived creation/update property inventory. |
| `src/budget.ts` | Enforce local limits, deduplicate reported usage, and trigger cancellation at the approved spending thresholds. |
| `src/collector.ts` | SSE, pending function handling, explicit root terminal checks, paginated root/child histories, usage snapshots and cleanup. |
| `src/evidence.ts` | Timestamped hash-linked JSONL records, exclusive output creation, secret redaction. |
| `src/cli.ts` | Manifest and request generation, optional read-only access check, gated study dispatch. |
| `src/decision.ts`, `src/replay.ts` | Integrity checks and preregistered supported/refuted/inconclusive decisions. |
| `src/reconcile.ts` | Read-only final-state and late-usage collection for the study's own sessions. |
| `src/analyze.ts` | Derive expected/actual values, child-answer checks and wait records without certifying the execution route. |
| `test/probe.test.ts` | Adversarial correctness, budget, attribution, lifecycle and official-SDK transport tests. |
| `src/followup.ts`, `src/followup-protocol.ts` | Six collection-repair trials and child/submission agreement separate from task accuracy. |
| `src/state-probe.ts`, `src/state-protocol.ts`, `src/state-store.ts` | Setup and lookup in the same session, immutable external bytes, exact handle checks, and fixed context pressure. |
| `src/state-decision.ts`, `src/state-replay.ts` | Retrieval success separate from independently verified compaction survival. |
| `test/followup.test.ts`, `test/state.test.ts` | Collection/task-error separation, storage integrity, locator rejection, pressure size, falsification and SDK continuation. |

The original v1 study refused paid dispatch because it could not establish a strict spending ceiling. OpenCnid subsequently authorized a **USD 2 reported-usage stopping threshold with possible overshoot**, recorded in the [Luna amendment](05-luna-two-dollar-protocol.md). Live dispatch now uses that contract; it does not claim a server-enforced dollar cap. The SDK remains pinned and no speculative budget parameter is sent.

The guard estimates cost conservatively at USD 0.50 per million input tokens and USD 1.80 per million output tokens, including reasoning within output once and giving no cached-input discount. It tracks each root/child turn by ID, retains the highest observed counts, and uses the greater of the session aggregate or sum of distinct turns. It cancels at USD 0.20 for a trial or USD 2 for the combined study. Estimates are not invoices, and missing usage is never zero.

The first live cohort stopped on an unsupported assumption that usage would arrive within thirty seconds. A [separate usage-lag amendment](06-usage-lag-amendment.md) retained that result and allowed the existing 120-second deadline while polling every ten seconds. The next control completed incorrectly and final usage was delayed again.

The [v4 amendment](07-control-and-accounting-amendment.md) allows two active children to match the two requested tasks and carries USD 0.054622 from both earlier attempts. Missing usage consumes the full USD 0.20 trial reservation when deciding whether another session can start. Once all observed turns have usage, admission uses the greater session/turn estimate. Telemetry, lifecycle or history errors still stop the cohort. This is an explicit change in the accounting policy; the previous stopped attempts remain in evidence. Task prompts, oracles and route grading remain unchanged.

`tracer_fixture` returns only synthetic data, and the oracle is calculated outside the model. A function result is durably logged before transmission. Same-call retries within a running collector return the saved result; changed arguments are rejected. There is no crash-resume implementation: after a crash, inspect retained records and pending service state before taking further action. The collector never silently restarts a paid trial.

The logger checks record integrity, not truthfulness of model statements. Route review requires an independently retained trace artifact, matching hash, actual session and span identifiers, and a named reviewer. The scorer cannot determine whether the reviewer interpreted that evidence correctly; it makes that dependency explicit. An unreviewed successful collection stays inconclusive.

For `direct-native`, the reviewer must identify two actual native child executions and their returned values. For `programmatic-local`, identify the executed program, fixture result, local loop and submission. For `programmatic-native`, additionally identify the program's native invocations, constructed inputs, completed child returns and in-program submission. A screenshot of proposed code alone is insufficient. If the dashboard omits the required caller or return relationship, leave the route unestablished; the probe cannot recover that fact from correct answers. Use `evidence/route-review.example.json` as the annotation template and retain the referenced trace artifact beside it.

The 40-request HTTP allowance applies separately to each trial, with four requests reserved for cancellation and final-state reads. Nine trials admit at most 360 requests. Page, event, tool and deadline bounds apply to each trial. None limits provider-internal work, which is why the separate paid gate is necessary.

The collector sends cancellation after interruption and retains conversation-only sessions for trace review. Cancellation acceptance does not prove all descendants have stopped. `reconcile` retrieves the study's own root and child turns, usage and saved history without resuming inference. A child resource can remain `active` while its turn is cancelled; resource availability is not proof of running work. Once trace evidence has been retained, delete only the study's own sessions using the official sessions-delete operation.

## Follow-up commands and shared budget

The [follow-up protocol](09-followup-protocol.md) uses six collection trials, then three separate external-state sessions when its collection gate passes. Both stages share one USD 2 reported-usage allowance. Stage A uses USD 0.20 per session. Stage B carries the reconciled Stage A admission estimate and uses USD 0.15 for the control and USD 0.70 for each pressure session, including both turns.

```sh
pnpm followup plan
pnpm followup run
pnpm reconcile evidence/runs/<collect-all-v5-run>
pnpm state-probe run evidence/runs/<collect-all-v5-run>/reconcile-<timestamp>/result.json
pnpm reconcile evidence/runs/<external-state-v6-run>
pnpm state-replay evidence/runs/<external-state-v6-run>
```

Stage B validates its prerequisite cohort and accounting artifact. A one-use `state-stage-claim.json` prevents another Stage B dispatch from resetting that same allowance. A failed or interrupted attempt requires explicit review; it is never automatically replaced. This guard was added after the published follow-up, which had only one Stage B attempt; its completed attempt is recorded in the claim with that timing disclosed.

The state probe creates an immutable file before setup, selects records after setup completes, and uses the SDK's subscribe-before-input continuation helper for the next turn on the same idle session. It reopens and hashes the file at retrieval and never repairs a wrong locator. Each turn has its own bounded HTTP transport and two-call/16-KiB function allowance; the session spending guard spans both turns. The 640-KiB pressure block is user input, not a function result, and is retained verbatim with its hash.

`state-replay` leaves compaction survival inconclusive without an independently reviewed service boundary. A `boundary-review.json`, if justified, must bind the actual session, protocol hash, retained artifact hash and span/event IDs, and establish that compaction happened after setup and before lookup. Model self-report and token-count changes are not acceptable substitutes. The current pressure trace reviews establish no such boundary.

## Explicit Responses compaction

The [Responses protocol](11-responses-compaction-protocol.md) has three paired fixtures and a separate shared USD 2 reported-usage allowance. It calls the standalone compact endpoint once per pair and continues with its complete output, preserving retained messages. It neither invokes nor observes managed Agents compaction.

```sh
pnpm compact-probe plan
pnpm compact-replay evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c
```

`compact-probe run` creates an exclusive `evidence/dispatch-responses-v7.json` before any inference. The published completed claim blocks another invocation; it is not a file to delete merely to retry a study. A new authorized cohort needs separate registration and accounting. The runner admits at most 21 sequential paid requests, reserves USD 0.30 per compact call and USD 0.05 per ordinary generation, and refuses admission when the reservation does not fit. Returned valid usage replaces reservations. Missing usage or an API/transport error stops further inference. Client timeouts do not prove server cancellation.

`compact-protocol.ts` defines the paired workflow and distinguishes a compact item from a visible retained handle. `compact-probe.ts` records every request and response, selects queries after compaction, checks exact read arguments and bytes, and scores submitted values separately. It uses ordinary function calls to isolate locator recovery. `compact-budget.ts` enforces request/output/body limits and the shared stopping threshold. The SDK is pinned; retries are disabled.

`compact-replay.ts` verifies committed source hashes, evidence chains, unchanged external files and the exact prefix of the treatment's continuation input. It also checks later query selection, oracle bytes and successful model submissions against the files. Replays save a new artifact when a previous replay exists; they do not call the API. [Observed results](12-responses-compaction-results.md).

## Original v4 commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm probe plan
pnpm probe preflight
pnpm probe run
pnpm replay evidence/runs/<run-directory>
pnpm reconcile evidence/runs/<run-directory>
pnpm analyze evidence/runs/<run-directory>
```

If the shell resolves another pnpm version, use `npx --yes pnpm@11.7.0` in place of `pnpm`. The global installation need not be changed. `.env.example` lists the configuration; the local `.env` is ignored by Git. Never paste a credential into a log or review artifact.

`plan` exits 0 after writing a plan. `preflight` and `run` exit 2 because neither automatically certifies the execution route; this can include a fully collected study awaiting review. A package-manager wrapper can return 1 while reporting the underlying code 2. Inspect `result.json` and per-trial `collection.json` to distinguish a collection failure from missing route review. Invalid invocation or damaged evidence also exits nonzero. `preflight --online` makes at most one read-only session-list request and records status and a result count without publishing existing session data. It verifies read access only.

Each study artifact directory contains `manifest.json`, `requests.json`, `sdk-audit.json`, `events.jsonl`, and `result.json`. Live trials additionally have their request, collection summary, event log and budget snapshot. Reconciliation writes a new timestamped subdirectory, leaving original observations intact. Manifests bind the model, code, SDK, protocol documents, limits and prior accounting to each run.

## Deliberate limits

There is no automatic generation-trace exporter, managed Agents compaction trigger, exact billing calculator, large-corpus benchmark, native-child context-isolation test, long-output test, or sandbox restoration test here. Explicit Responses compaction is a separate component experiment. The conservative spending estimate only supports the agreed stopping policy. Prerequisites and follow-up tests are stated explicitly rather than inferred from tiny tasks.
