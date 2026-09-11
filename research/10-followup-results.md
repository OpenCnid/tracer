# Exact external state worked. Survival across compaction is still unproven.

**OpenCnid's follow-up recovered exact external data in all three sessions, including two with substantial context pressure. We could not establish that managed compaction occurred.** This moves the investigation forward, but it does not yet answer whether the same workflow survives compaction.

We also improved child-result collection. Remaining failures involved missing task inputs and incorrect string transformations. They did not reveal a categorical rejection of RLM-style work by the Agents API.

The complete follow-up has a conservative usage estimate of **$1.38**, below its shared $2 stopping threshold. No further paid work was started after the fixed tests finished.

## The test that addresses our original concern

RLM needs exact data to remain outside the model's working memory, while the model retains enough information to find it again. We tested that requirement directly:

1. We created an immutable external file containing 512 random records, totaling **1,061,346 bytes**. The complete file was never supplied to the agent.
2. In a setup turn, the agent received a random **handle**: a locator for that file.
3. After setup finished, the runner selected two records to retrieve. The agent could not know those selections during setup.
4. A new turn requested those records without supplying the handle again.
5. The agent had to recover its earlier handle, read the selected records through a tool, and submit their exact values. Our application checked them against the original file.

One session was a short control. Each of the other two received **640 KiB of irrelevant synthetic text** before the lookup request. This was one fixed pressure dose, not an adaptive search for a pass.

| Session | Added pressure | Earlier handle recovered | Exact selected records | External file unchanged |
| --- | --- | --- | --- | --- |
| Short control | None | Yes | 2 of 2 | Yes |
| Pressure trial 1 | 640 KiB | Yes | 2 of 2 | Yes |
| Pressure trial 2 | 640 KiB | Yes | 2 of 2 | Yes |

These are observed tool arguments, returned bytes, submissions and file hashes. The application did not repair a missing handle or let the agent request a new one. [Structured retrieval evidence](../evidence/runs/2026-09-11T01-52-28-259Z-external-state-v6-run-2af92214/analysis.json).

**What this establishes:** exact external storage and later retrieval can work within these vendor-managed sessions. OpenAI controlled the model loop and context; our application supplied storage and tools.

**What it does not establish:** retrieval after compaction, exclusion of intermediate results from the parent's context, arbitrary recursion, process-restart recovery, or long-context benchmark performance.

## Why compaction survival remains unknown

We inspected both pressure timelines and all five recorded generation spans in **each** session. Neither exposed a service compaction item or an identifiable compaction boundary. The pinned public Agents schema also has no compaction-completed event or documented compaction trigger.

The traces record the new lookup message and later tool results. They do not certify every complete rendered model input. Successful retrieval and token totals cannot fill that gap. The approximately 1.08 million tokens recorded per pressure session are usage accumulated across work; they are **not evidence that one model input exceeded its context window**.

The fixed dose may simply have been insufficient to cause compaction. We did not add more filler or substitute the Responses API's separate compaction mechanism.

The result is therefore **retrieval passed; compaction survival inconclusive**. Replay verifies 835 evidence records and preserves that distinction. [Replay result](../evidence/local-tests/replay-v6.json), [first pressure trace review](../evidence/trace-reviews/v6-s2-pressure/review.json), [second pressure trace review](../evidence/trace-reviews/v6-s3-pressure/review.json).

## What happened to the earlier collection failure

Before the state test, we ran six fresh reversal trials. Both workflows now explicitly tracked outstanding child IDs and kept waiting for the remaining answers.

| Workflow | Submitted both assigned children's final answers unchanged | Both reversals correct |
| --- | --- | --- |
| Direct delegation | 3 of 3 | 1 of 3 |
| Delegation requested from code | 2 of 3 | 1 of 3 |

Every trial recorded two completed waits. None submitted the earlier `undefined` placeholder. One programmatic trial omitted the nonce from both child prompts: it asked the children to reverse a string without giving them the string. They returned error messages, which the parent submitted. Neither child could be mapped to its assigned nonce, so this fails our collection-agreement criterion as well as task correctness.

The other programmatic failure collected both answers but included an incorrect reversal. Two direct controls did the same. The repair improved the specific missing-result behavior; it did not make the workflow reliable. [Collection evidence and reported programs](../evidence/runs/2026-09-11T01-41-41-891Z-collect-all-v5-run-785e1659/analysis.json).

We also corrected an expectation about tracing. Signing into the dashboard did **not** reveal the executing JavaScript in the inspected spans. We retained the model's reported source separately and labeled it as such. Neither those reports nor flattened tool items independently establish the native calls' relationship to a running program. [Earlier failure's newly inspected traces](../evidence/trace-reviews/v4-b1-native/review.json).

## Our decision now

**The evidence supports continuing with an adapter that keeps exact state in application storage. It does not yet justify claiming a faithful native RLM port or replacing our existing harness.** We found no demonstrated incompatibility between external exact state and managed context, but the critical post-compaction behavior remains unmeasured.

The next dependency is an observable managed compaction boundary: a documented event, usable trace marker, or another independently verifiable signal. Once available, this state probe can test recovery across it with the same later-selected records and exact-value checks. Increasing spending without that signal would leave the interpretation problem unresolved.

## Accounting and reproducibility

The protocol was committed before paid requests. The follow-up made **nine session-creation requests and three continuation submissions**, with no replacement trials. All used `gpt-5.6-luna` through `openai@7.15.0`. TypeScript checks and **42 local tests** passed; those tests use mock transport, while the session evidence above comes from the real service. [Frozen protocol](09-followup-protocol.md), [local tests](../evidence/local-tests/vitest-v6.json).

After the runs, we added a one-use dispatch guard so rerunning Stage B cannot reset its shared spending allowance. The current suite passes **43 tests**; no paid run was repeated for that change. Original run source hashes remain in their manifests. [Final local checks](../evidence/local-tests/vitest-followup-final.json).

Read-only reconciliation found all nine sessions idle, zero pending actions, and all observed root/child turns complete. Usage was available for every observed turn. The final conservative estimate was **$1.3847683**, including **$0.2739385** from the collection stage. This is not a final invoice. The earlier study's separately reported estimate was about $0.37; adding the two study estimates gives about $1.75. [Collection reconciliation](../evidence/runs/2026-09-11T01-41-41-891Z-collect-all-v5-run-785e1659/reconcile-2026-09-11T01-50-23-665Z/result.json), [combined follow-up reconciliation](../evidence/runs/2026-09-11T01-52-28-259Z-external-state-v6-run-2af92214/reconcile-2026-09-11T01-57-43-928Z/result.json).
