# Recovering work in a fresh managed Agents session

**OpenCnid recovered and finished all three saved tasks in new managed Agents sessions. None repeated a completed job. But all three hit a reporting or tool-argument error along the way, so none passed the implementation's stricter error-free workflow check.**

All three unbound controls correctly reported that no task was available. The study created nine real managed sessions: three setup sessions, three bound resumes and three unbound controls. We did not change prompts, replace trials or repair model arguments during the run.

This is positive evidence for **application-owned checkpoint recovery on the managed Agents API**. It is negative evidence for expecting this exact prompt and tool interface to work without validation feedback. **Actual managed-compaction survival remains unmeasured.**

The complete study's reconciled estimate was **$0.178804**, about 18 cents, below its shared $2 stopping threshold. All nine sessions ended idle with completed turns and no pending actions.

## What happened in the three recoveries

| Task | Saved state found; remaining work completed | Completed job repeated | Error observed | Eventual exact report | Strict workflow score |
| --- | --- | --- | --- | --- | --- |
| 1 | Yes | No | First report omitted the old job's result; corrected after rejection | Yes | Negative |
| 2 | Yes | No | First report omitted the old job's result; corrected after rejection | Yes | Negative |
| 3 | Yes | No | One character missing from a tool-call handle; re-read state and retried correctly | Yes | Negative |

For tasks 1 and 2, the first reports correctly identified which job had been completed before the handoff, but included result objects only for the two new jobs. The validator returned `accepted: false`. The model then submitted all three exact results. The application did not insert the missing result or provide a repaired report.

For task 3, the model correctly processed the first pending job, then supplied a mistyped handle for the second. The tool rejected that call without performing the operation. The model called `current_task_state()` again, obtained the exact handle and updated completion status, and finished the remaining job. Its one report was correct.

Across the three tasks, we observed **nine operation effects**: three setup jobs and six resumed jobs. All original completed receipts remained byte-for-byte unchanged. There were **zero requests to repeat a completed job**. The third task's rejected attempt did not create an extra operation.

The three unbound controls received no task data and each submitted one correct blocked report with empty arrays. They made no processing attempts. [Full structured results](../evidence/runs/2026-09-11T03-42-25-736Z-checkpoint-resume-v8-86b26841/result.json).

## What we tested

Imagine three jobs: A, B and C. An agent finishes A. We save its exact result outside the conversation, then start a completely new agent session. Can that session discover that A is already done, finish B and C, and report all three results correctly?

We ran that workflow on the **managed Agents API**. OpenAI ran each model loop; our application supplied ordinary function tools and local storage. This study disabled programmatic tool calling and native subagents to isolate recovery from the delegation questions in our earlier tests.

Each of three independent tasks had a file larger than 1 MiB, containing 512 random records. Three jobs selected different records. A processing tool hashed the selected record, generated a random receipt, and saved one result file. That file was the operation's entire effect. The model selected jobs and copied exact digests and receipts; it did not perform the hashing itself.

The setup agent was instructed to process only the first job. After checking that result, the application froze hashes of the source, task definition and completed receipt. It then created a new managed session and durably bound that session's actual ID to the saved task.

The new session received **no old conversation, task handle, job IDs, receipts or old session ID** in its request. It had a tool called `current_task_state()` with no arguments. The application used the calling session's binding to reopen the checkpoint from disk and return the task's handle, completed results and pending jobs.

Each task also had an **unbound control**: another fresh session with the same instructions and tools, but no application task binding. Its state tool returned only `unbound`. It was instructed to report blocked with empty result arrays and make no processing attempt. We alternated bound/control order across tasks.

## Why this matters for our original concern

The [Responses experiment](12-responses-compaction-results.md) showed that a small locator could survive an explicit compaction. This experiment asks whether the managed workflow can recover that locator from application storage when the old conversation is absent altogether.

The design moves a requirement out of model memory: the model does not have to remember which file or task it was working on. The application keeps that association and exposes a stable discovery tool. Exact results and completion status also live outside the conversation.

That still leaves requirements on the managed agent. It must have access to the tool, call it when resuming, respect completed-job status, and use the returned data correctly. A correct checkpoint alone cannot guarantee those behaviors.

Our engineering inference is to keep authoritative result assembly in the application, using validated saved receipts, and avoid requiring the model to copy a long task handle when the application already has a session binding. Those are recommendations from the observed failures, not fixes tested in this cohort.

**A fresh session is not an observed managed-compaction boundary.** It has fresh instructions and a deliberate resume request. Automatic compaction could happen during a different phase of work, with outstanding actions or subtasks. This study does not tell us when it occurs or what the harness retains. We did not inject a Responses compaction item into Agents or assume the two APIs share an internal mechanism.

## What the controls and checks mean

- A successful bound resume requires exact old-result preservation, both pending operations executed once, no new request to repeat a completed job, and one accurate report distinguishing old from new work.
- A successful unbound control is an explicit blocked report with empty arrays and no processing attempt. It checks that a fresh session does not acquire task data through the request or a fallback lookup.
- A repeated delivery of the same session/turn/call ID reuses the saved tool output. A new call asking for an already completed job is recorded as a duplicate attempt, even though the adapter prevents another operation. Preventing a duplicate does not turn that attempt into a passing recovery.
- Local fault-injection tests check rejection of changed files, binding isolation, exact reporting, durable call reuse and duplicate prevention. These are implementation checks, separate from real model observations.

There is a scoring qualification. The pre-run implementation requires **one** report and **no rejected tool calls**. The protocol prose focuses on exact **final** recovery without explicitly excluding corrected reports or a rejected attempt at pending work. The prompt also instructs one report. These are different success criteria. We retain the implementation's three negative scores and separately report the three eventual exact recoveries. The errors must not be described as permanent loss of the checkpoint or evidence that recovery is impossible. The first-report accuracy was 1 of 3; eventual report accuracy was 3 of 3.

The fixture is deliberately small. It does not establish arbitrary checkpoint quality, concurrent-worker safety, crash-atomic remote transactions, recursion, native delegation or RLM benchmark performance. The operation's single local result file makes its effect inspectable; the same guarantee would need separate work for an external side effect.

## Protocol and implementation

The [fixed protocol](13-checkpoint-resume-protocol.md) was committed at `276270b` before implementation and inference. The runner, replay and 65 passing local tests were committed at `74cec9a` before the first paid session. The protocol hash is recorded in [preregistration-v8.json](../evidence/preregistration-v8.json).

The implementation is in [checkpoint-store.ts](../src/checkpoint-store.ts), [checkpoint-ledger.ts](../src/checkpoint-ledger.ts), [checkpoint-protocol.ts](../src/checkpoint-protocol.ts) and [checkpoint-probe.ts](../src/checkpoint-probe.ts). It uses the official SDK's managed session creation and event APIs, with the existing bounded collector. No model loop was replaced with a local Responses loop.

[OpenAI's function-tool documentation](https://developers.openai.com/api/docs/guides/agents-api/tools/functions) describes application-owned functions and durable storage of their results. The [session documentation](https://developers.openai.com/api/docs/guides/agents-api/sessions) distinguishes new sessions from continuations. Those interfaces provide the implementation points; the measurements above must come from our own evidence.

## Evidence, accounting and replay

The run used `gpt-5.6-luna`, official SDK `openai@7.15.0`, Node `v24.19.0` and pnpm `11.7.0`, from 03:42:25 to 03:49:45 UTC on September 11, 2026. It created nine new managed sessions with one root turn each, ordinary function tools, no sandbox and no child agents. Nine sessions are not nine internal model generations: OpenAI handled the repeated model/tool exchanges within each turn. [Run manifest](../evidence/runs/2026-09-11T03-42-25-736Z-checkpoint-resume-v8-86b26841/manifest.json).

Read-only reconciliation found **339,320 input tokens and 5,080 output tokens**, with usage present for every turn. The guard prices input at $0.50/M and output at $1.80/M, ignoring cache discounts. That produces the $0.178804 estimate; it is not an invoice. All nine sessions were idle, all nine turns completed, and there were no pending actions or children. [Reconciled accounting and lifecycle](../evidence/runs/2026-09-11T03-42-25-736Z-checkpoint-resume-v8-86b26841/reconcile-2026-09-11T03-50-21-528Z/result.json).

At initial collection, delayed usage left some reservations outstanding, producing a conservative admission total of $0.9769277. We retained those reservations when deciding whether to start later trials. Reconciliation resolved the delayed usage afterward; it did not authorize more inference. The stopping threshold permits delayed-reporting overshoot, as authorized, and the runner did not represent it as a guaranteed billing cap.

Offline replay verified **11 hash-linked logs with 2,141 records**, nine distinct session IDs, nine operation effects, zero duplicate completed-job attempts and zero transport redeliveries. It checked the clean new-session requests, durable bindings, task/source hashes, original completed receipt hashes, manifests at each call, job-result digests against source records, exact reports and the saved classifications. No paid observations exercised the transport-redelivery branch; that branch was tested locally. [Replay output](../evidence/runs/2026-09-11T03-42-25-736Z-checkpoint-resume-v8-86b26841/replay.json), [65 passing local tests](../evidence/local-tests/vitest-v8.json).

```sh
pnpm checkpoint-probe plan
pnpm checkpoint-replay evidence/runs/2026-09-11T03-42-25-736Z-checkpoint-resume-v8-86b26841
```

These commands perform no inference. The completed study's exclusive dispatch claim prevents `checkpoint-probe run` from silently resetting the allowance. A further paid cohort needs its own authorization and accounting.
