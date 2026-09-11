# Implementation

The implementation uses TypeScript, pnpm 11.7.0, the official `openai` SDK pinned to 7.15.0, and Vitest 4.1.8. The Node engine matches the requested `^22.19.0 || >=24.0.0`. TypeScript, tsx and Node typings match the examined DeepSeek RLM package versions. The dependency lockfile is committed. The current cohort requests `gpt-5.6-luna`.

The code has four jobs: generate the frozen trial matrix, enforce admission gates, collect raw evidence through the official API surface, and conservatively score independently reviewed evidence. It does not implement another model loop or a persistent RLM product.

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

The original v1 study refused paid dispatch because it could not establish a strict spending ceiling. OpenCnid subsequently authorized a **USD 2 reported-usage stopping threshold with possible overshoot**, recorded in the [Luna amendment](05-luna-two-dollar-protocol.md). Live dispatch now uses that contract; it does not claim a server-enforced dollar cap. The SDK remains pinned and no speculative budget parameter is sent.

The guard estimates cost conservatively at USD 0.50 per million input tokens and USD 1.80 per million output tokens, including reasoning within output once and giving no cached-input discount. It tracks each root/child turn by ID, retains the highest observed counts, and uses the greater of the session aggregate or sum of distinct turns. It cancels at USD 0.20 for a trial or USD 2 for the combined study. Estimates are not invoices, and missing usage is never zero.

The first live cohort stopped on an unsupported assumption that usage would arrive within thirty seconds. A [separate usage-lag amendment](06-usage-lag-amendment.md) retained that result and allowed the existing 120-second deadline while polling every ten seconds. The next control completed incorrectly and final usage was delayed again.

The [current amendment](07-control-and-accounting-amendment.md) allows two active children to match the two requested tasks and carries USD 0.054622 from both earlier attempts. Missing usage consumes the full USD 0.20 trial reservation when deciding whether another session can start. Once all observed turns have usage, admission uses the greater session/turn estimate. Telemetry, lifecycle or history errors still stop the cohort. This is an explicit change in the accounting policy; the previous stopped attempts remain in evidence. Task prompts, oracles and route grading remain unchanged.

`tracer_fixture` returns only synthetic data, and the oracle is calculated outside the model. A function result is durably logged before transmission. Same-call retries within a running collector return the saved result; changed arguments are rejected. There is no crash-resume implementation: after a crash, inspect retained records and pending service state before taking further action. The collector never silently restarts a paid trial.

The logger checks record integrity, not truthfulness of model statements. Route review requires an independently retained trace artifact, matching hash, actual session and span identifiers, and a named human reviewer. The scorer cannot determine whether the reviewer interpreted that evidence correctly; it makes that dependency explicit. An unreviewed successful collection stays inconclusive.

For `direct-native`, the reviewer must identify two actual native child executions and their returned values. For `programmatic-local`, identify the executed program, fixture result, local loop and submission. For `programmatic-native`, additionally identify the program's native invocations, constructed inputs, completed child returns and in-program submission. A screenshot of proposed code alone is insufficient. If the dashboard omits the required caller or return relationship, leave the route unestablished; the probe cannot recover that fact from correct answers. Use `evidence/route-review.example.json` as the annotation template and retain the referenced trace artifact beside it.

The 40-request HTTP allowance applies separately to each trial, with four requests reserved for cancellation and final-state reads. Nine trials admit at most 360 requests. Page, event, tool and deadline bounds apply to each trial. None limits provider-internal work, which is why the separate paid gate is necessary.

The collector sends cancellation after interruption and retains conversation-only sessions for trace review. Cancellation acceptance does not prove all descendants have stopped. `reconcile` retrieves the study's own root and child turns, usage and saved history without resuming inference. A child resource can remain `active` while its turn is cancelled; resource availability is not proof of running work. Once trace evidence has been retained, delete only the study's own sessions using the official sessions-delete operation.

## Run commands

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

There is no automatic generation-trace exporter, service-compaction trigger, exact billing calculator, large-corpus benchmark, native-child context-isolation test, long-output test, or sandbox restoration test here. The conservative spending estimate only supports the agreed stopping policy. Prerequisites and follow-up tests are stated explicitly rather than inferred from tiny tasks.
