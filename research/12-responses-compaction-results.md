# Exact external state survived explicit Responses compaction

**OpenCnid observed compaction and then recovered exact external data in all three trials.** Each paired control also passed. Unlike our earlier managed Agents tests, this experiment has an identified compaction operation and a recorded compacted context used for continuation.

The result applies to **Responses**, where we called `/responses/compact` ourselves. It does not establish when the managed Agents API compacts or how that harness behaves afterward.

The complete study cost an estimated **$0.09623**, about ten cents, using conservative token rates. It stayed below its shared $2 stopping threshold. This is an estimate, not an invoice.

## What actually happened

For each of three fresh fixtures, we created an external file larger than 1 MiB. It held 512 random records. The model received only a tool result containing the file's random handle, its record count and 16 KiB of irrelevant notes. It acknowledged setup with “Ready.” The complete records never entered that setup history.

We sent the history to `/responses/compact`. In **every** returned context, OpenAI retained exactly:

1. The original user request, which did not contain the handle.
2. An identified encrypted compaction item.

The original manifest tool result and assistant acknowledgement were absent. Our scan found **no handle in the readable contents** of any compacted context. We preserved the whole returned context unchanged; we did not remove inconvenient retained messages.

Only then did the runner randomly select two records. It sent the same lookup request down two separate branches. The control used the original history. The treatment used the compacted context. Neither query repeated the handle, and neither branch received the other branch's outputs. Both used stateless Responses requests, with no Conversation or `previous_response_id` linking them to older history.

The model had to supply the correct earlier handle to our read tool. The tool reopened the original file, verified its hash and returned the exact requested records. A further model generation submitted those values, and the application checked them independently.

| Pair | Newly selected records | Control: exact retrieval and submission | After compaction: exact retrieval and submission | Readable handle retained |
| --- | --- | --- | --- | --- |
| 1 | 372, 431 | Passed | Passed | No |
| 2 | 367, 454 | Passed | Passed | No |
| 3 | 234, 456 | Passed | Passed | No |

All six lookups used the correct handle and indices. All six submissions contained the exact two 2,048-character record values. All three external files retained their original hashes. There were no failed API calls, replacement trials or prompt changes during the run. [Structured results](../evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c/result.json).

## Why this is stronger evidence than the pressure tests

We did not infer compaction from a long prompt or from the model saying it happened. We recorded a successful response from the compact endpoint, an encrypted compaction item, and the exact subsequent request that consumed its entire output. The three compaction item IDs are retained in [the replay evidence](../evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c/replay.json).

The first retrieval generation also used substantially less input after compaction:

| Pair | Control input tokens | Compacted input tokens |
| --- | ---: | ---: |
| 1 | 9,759 | 689 |
| 2 | 9,818 | 659 |
| 3 | 9,791 | 698 |

These are usage counts for individual Responses generations. They are supporting evidence of a smaller continuation, not our proof that compaction occurred. The service's compact result supplies that boundary.

**Our inference:** the returned compacted context carried enough information to recover the exact locator in these three cases. That inference is supported by the absent readable handle, the exclusive continuation input and the successful read arguments. The encrypted representation is opaque; we cannot inspect how it encoded the handle or claim a particular internal algorithm.

## What this means for the original RLM question

This is positive evidence for one important design choice: **keep exact data in application storage, and carry a small locator through the model's context.** OpenAI's explicit Responses compaction preserved that ability in our tested workflow. Neither the full dataset nor exact intermediate data needed to be preserved in readable model history.

The managed Agents question remains separate. In our [earlier follow-up](10-followup-results.md), external-state retrieval passed, but we could not establish a compaction boundary. We have not shown that the managed harness uses this same compact operation, nor that it would preserve the locator under its own timing and context policy.

Three small, explicitly compacted histories are also not a reliability guarantee. We did not test repeated compactions, very long histories, outstanding child jobs, arbitrary recursion, programmatic delegation or restart recovery. This study deliberately used ordinary function calls to isolate locator preservation; it is not a full RLM implementation or benchmark.

The decision is therefore more specific now: **the external-storage pattern survived known Responses compaction; a faithful RLM port to managed Agents remains unverified.**

## Reproduce and inspect

The [protocol](11-responses-compaction-protocol.md) was committed at `260cd08` before paid requests. The runner and 51 passing local tests were committed at `3108d7d`; its source hashes appear in the [run manifest](../evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c/manifest.json). The offline replay utility was added afterward and did not change or repeat paid work.

The run used `gpt-5.6-luna`, `openai@7.15.0`, Node `v24.19.0` and pnpm `11.7.0`, from 03:10:48 to 03:12:52 UTC on September 11, 2026. It made exactly **21 paid requests: 3 compact operations and 18 ordinary Responses generations**. All returned successfully with usage; no background generations or managed Agents sessions were created. Ordinary Responses objects report the requested model. The compact objects do not return a model field, so that endpoint's model attribution rests on the recorded request rather than an invented returned field.

Recorded totals were 135,958 input tokens and 15,695 output tokens. The guard prices all input at $0.50/M and output at $1.80/M, ignoring cache discounts, for the $0.09623 estimate. It reserved spending before requests and would have stopped on missing usage or the threshold. SDK retries were disabled. [Accounting](../evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c/result.json), [local test report](../evidence/local-tests/vitest-v7.json).

Offline replay verified 10 hash-linked logs containing 87 records, the committed source hashes, immutable file hashes, full compact inputs, exact canonical continuation prefixes, later query selection, read arguments and returned/submitted records. Each pair directory contains the original requests and responses, so the verdict is reviewable without trusting this report.

```sh
pnpm compact-probe plan
pnpm compact-replay evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c
```

`compact-probe run` is intentionally blocked by the completed study's exclusive dispatch claim. A new paid cohort needs its own explicit authorization and accounting; rerunning the command must not silently create a fresh $2 allowance.

The [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint) specifies retaining the entire canonical returned context. The [API reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/compact) describes the response object and usage. Neither establishes a bridge into an existing managed Agents session.
