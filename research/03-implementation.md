# Implementation

The implementation uses TypeScript, pnpm 11.7.0, the official `openai` SDK pinned to 7.15.0, and Vitest 4.1.8. The Node engine matches the requested `^22.19.0 || >=24.0.0`. TypeScript, tsx and Node typings match the examined DeepSeek RLM package versions. The dependency lockfile is committed.

The code has four jobs: generate the frozen trial matrix, enforce admission gates, collect raw evidence through the official API surface, and conservatively score independently reviewed evidence. It does not implement another model loop or a persistent RLM product.

| File | Role |
| --- | --- |
| `src/protocol.ts` | Nine-trial matrix, independent deterministic fixtures, exact oracle, three request arms. |
| `src/sdk-audit.ts` | Actual SDK version, source hashes, AST-derived creation/update property inventory. |
| `src/budget.ts` | Refuse unsupported paid admission; enforce tool-byte and request limits. |
| `src/collector.ts` | SSE, pending function handling, explicit root terminal checks, paginated root/child histories, usage snapshots and cleanup. |
| `src/evidence.ts` | Timestamped hash-linked JSONL records, exclusive output creation, secret redaction. |
| `src/cli.ts` | Manifest and request generation, optional read-only access check, gated study dispatch. |
| `src/decision.ts`, `src/replay.ts` | Integrity checks and preregistered supported/refuted/inconclusive decisions. |
| `test/probe.test.ts` | Adversarial correctness, budget, attribution, lifecycle and official-SDK transport tests. |

The budget gate is intentionally closed for this SDK. The collector is implemented and exercised against mocked HTTP through the real SDK; it has **not** been validated against a real managed session. There is no pretend SDK method, speculative budget parameter, automatic SDK upgrade, or CLI escape hatch. The live dispatch path cannot run until a newly reviewed protocol supplies an enforceable spending contract.

`tracer_fixture` returns only synthetic data, and the oracle is calculated outside the model. A function result is durably logged before transmission. Same-call retries within a running collector return the saved result; changed arguments are rejected. There is no crash-resume implementation: after a crash, inspect retained records and pending service state before taking further action. The collector never silently restarts a paid trial.

The logger checks record integrity, not truthfulness of model statements. Route review requires an independently retained trace artifact, matching hash, actual session and span identifiers, and a named human reviewer. The scorer cannot determine whether the reviewer interpreted that evidence correctly; it makes that dependency explicit. An unreviewed successful collection stays inconclusive.

For `direct-native`, the reviewer must identify two actual native child executions and their returned values. For `programmatic-local`, identify the executed program, fixture result, local loop and submission. For `programmatic-native`, additionally identify the program's native invocations, constructed inputs, completed child returns and in-program submission. A screenshot of proposed code alone is insufficient. If the dashboard omits the required caller or return relationship, leave the route unestablished; the probe cannot recover that fact from correct answers. Use `evidence/route-review.example.json` as the annotation template and retain the referenced trace artifact beside it.

The 40-request HTTP allowance applies separately to each trial, with four requests reserved for cancellation and final-state reads. Nine trials admit at most 360 requests. Page, event, tool and deadline bounds apply to each trial. None limits provider-internal work, which is why the separate paid gate is necessary.

The collector sends cancellation after interruption and retains conversation-only sessions for trace review. Cancellation acceptance does not prove all descendants have stopped. Once trace evidence has been retained, delete only the study's own sessions using the official sessions-delete operation. The current run created no sessions and needs no remote cleanup.

## Run commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm probe plan
pnpm probe preflight
pnpm probe run
pnpm replay evidence/runs/<run-directory>
```

If the shell resolves another pnpm version, use `npx --yes pnpm@11.7.0` in place of `pnpm`. The global installation need not be changed. `.env.example` lists the configuration; the local `.env` is ignored by Git. Never paste a credential into a log or review artifact.

`plan` exits 0 after writing a plan. `preflight` and the presently blocked `run` exit 2 with an inconclusive result; a package-manager wrapper can return 1 while reporting the underlying code 2. Invalid invocation, damaged evidence or other implementation errors exit nonzero. `preflight --online` makes at most one read-only session-list request if a credential is configured; it records HTTP status and a result count, without publishing existing session data. This verifies read access only, not inference access or native-recursion support.

The initial study artifact directory contains `manifest.json`, `requests.json`, `sdk-audit.json`, `events.jsonl`, and `result.json`. If a future approved protocol permits live collection, each trial additionally has its request, collection summary and event log. No absent count is converted to zero usage. A source change is recorded through source hashes even if a development tree has not yet been committed.

## Deliberate limits

There is no automatic generation-trace exporter, service-compaction trigger, provider pricing estimator, large-corpus benchmark, native-child context-isolation test, long-output test, or sandbox restoration test here. None is necessary to answer the first interface question. The prerequisites and next tests are stated in the frozen protocol, rather than silently inferred from a tiny successful task.
