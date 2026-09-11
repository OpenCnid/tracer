# What the context detector found

**Continuation:** We have now completed calibration and all six planned managed sessions. [Read the completed study](23-managed-observation-results.md). The original interrupted result below is preserved as recorded.

**We built the detector and obtained promising calibration measurements. We did not reach managed Agents testing: the last calibration fixture was interrupted by a request failure. Survival across managed compaction is still inconclusive.**

This study tests the measurement we need before making a survival claim. It does not change our [decision to keep exact state in application storage](../DECISIONS.md).

## Think of this as testing a sensor

Before putting the sensor into an opaque managed session, we gave it histories whose changes we controlled. We asked for a tiny `ACK`, measured total input tokens, changed the supplied history, and measured again. We compared four conditions:

- Keep the full history.
- Call OpenAI's explicit Responses compact endpoint and use its entire returned context.
- Delete an old prefix ourselves.
- Keep a rolling window that evicts older exchanges.

The detector learned one rule from a development fixture: **input usage must fall by at least 50% and 2,048 tokens, then remain below that ceiling for two more measurements.** We saved the rule before the held-out requests. We did not change it afterward.

## The token signal worked in the measurements we collected

These are actual input-token counts, including cached tokens. The three post-change measurements are separate requests.

| Fixture | Before change | Full history afterward | Known compaction afterward | Prefix deletion afterward |
| --- | ---: | --- | --- | --- |
| Development | 9,959 | 9,959 → 9,975 → 10,033 | 627 → 643 → 701 | 2,525 → 2,541 → 2,599 |
| Held-out 1 | 10,052 | 10,052 → 10,068 → 10,131 | 481 → 497 → 560 | 2,589 → 2,605 → 2,668 |
| Held-out 2, incomplete fixture | 10,043 | 10,043 → 10,059 → 10,120 | 636 → 652 → 713 | 2,598 → 2,614 → 2,675 |

All three known-compaction trajectories triggered the fixed rule. All three deletion trajectories triggered it too. The two completed rolling-window trajectories also triggered. None of the three full-history trajectories did. One fixture developed the rule; the other two supplied held-out measurements. The second held-out fixture did **not** finish its entire scheduled set of requests.

This is a useful **context-reduction signal**, with a clear limitation: **a token drop does not identify compaction specifically.** Deletion produces the same signal. These small, controlled examples do not establish an error rate or prove that Agents turn-level accounting behaves the same way.

The rule was deliberately selected to detect both kinds of reduction. That does not prove that every possible classifier must fail. A larger drop threshold could separate these particular compaction and deletion doses, but would be distinguishing the amount removed; deleting a larger prefix could produce an equally large drop. We have not validated a mechanism-specific classifier.

Caching did not fool this test. For example, two identical development requests both reported 9,959 input tokens, while cached tokens changed from zero to 9,956. A detector using only uncached tokens would have mistaken that for a near-total context reduction. Our detector uses the total.

## The recall test exposed a misleading pattern

We put arbitrary important task facts next to irrelevant random codes. All three compacted branches returned all four queried old task facts correctly and returned `null` for their neighboring codes. Taken alone, that looks like selective summarization.

But we also added a fresh fact and code **after** compaction, in a normal visible message. All three compacted branches returned that fresh task fact and still returned `null` for the fresh code. The full-history branches returned every queried value correctly. The fresh code was supplied in the compacted branch's request; it had never gone through the compact operation.

**Failing to repeat information is therefore not a trustworthy indication that the information was removed.** We observed an answering failure for visibly supplied data. We cannot tell from these records why the model omitted it. Under the protocol, the failed recent-code control prevents treating the old-code omissions as a reliable signature of summarization.

This is a substantive negative for the proposed recall-based distinction. We should keep recall as a behavioral observation, not use it to certify what the harness discarded. Earlier [Responses retrieval tests](12-responses-compaction-results.md) also showed that compaction can preserve exact arbitrary locators; forgetting is neither necessary nor sufficient.

## What stopped the study

The development fixture and first held-out fixture completed and passed the calibration gate. During the second held-out fixture, attempt 53—the prefix-deletion recall request—raised a `TypeError` before a parsed response was saved. Its request was recorded; its response, usage and request ID were not. The remaining four rolling-window requests were never attempted.

That is a collection/transport failure, not a failed ACK or evidence against RLM. **The saved evidence cannot establish whether the cause was transport, response shape, SDK processing or another client failure.** Our error record preserved the error type but lacked the raw HTTP response and stack needed to diagnose it. We do not attribute it to OpenAI.

The frozen protocol stops further paid work when a request's usage is unresolved. The runner kept that request's reservation and stopped. It did not dispatch any managed session, replace the incomplete fixture, raise the budget or reset its one-use claim. The study ended with an incomplete calibration gate, not a calibration pass or fail.

After the run, we added capture of response status, request ID and bounded body **before SDK parsing**, and extended replay to expose the partial fixture instead of omitting it. A local mock test confirms that the new capture preserves evidence even when the pinned SDK throws on malformed output. That mock does not reproduce or explain the live failure. No further paid calls tested the change.

## Cost and provenance

- Run: [context-observation-v9-d3b43f6e](../evidence/runs/2026-09-11T13-13-03-969Z-context-observation-v9-d3b43f6e/manifest.json), September 11, 2026, 13:13:03–13:14:26 UTC.
- Official SDK **7.15.0**, model **gpt-5.6-luna**, Node **v24.19.0**, pnpm **11.7.0**; SDK retries disabled.
- **53 request attempts, 52 saved responses:** three compact responses and 49 ordinary Responses results. One attempted ordinary request has unknown usage. **Zero managed Agents sessions.**
- Known usage: **255,969 input / 2,719 output tokens**, estimated at **$0.1328787** using the frozen conservative rates. Adding the unresolved request's $0.03 reservation gives **$0.1628787 for admission accounting**. Neither number is the final bill or an upper bound on the unknown request. The shared stopping threshold remained $2; it was not exhausted.
- Protocol commit [`b86f993`](https://github.com/OpenCnid/tracer/commit/b86f993); implementation and pre-inference recent-control clarification [`03f7da5`](https://github.com/OpenCnid/tracer/commit/03f7da5). The manifest hashes the precise executed sources. Later diagnostic changes are separate.
- **75 local tests passed before inference; 76 passed after the diagnostic addition.** Replay verifies four hash-linked logs containing 108 records, checks the recorded source commit, recomputes completed trajectories and recall scores, and exposes the partial fixture. Local mocks are not real API runs.

[Frozen protocol](16-observation-protocol.md) · [Dispatch claim](../evidence/dispatch-observation-v9.json) · [Original stopped result](../evidence/runs/2026-09-11T13-13-03-969Z-context-observation-v9-d3b43f6e/result.json) · [Read-only replay](../evidence/analysis/2026-09-11-observation-v9-replay.json)

## What this means for the original concern

We now have a candidate way to observe **context reduction**, and evidence against using selective recall alone to call it compaction. We have **not** shown that the detector transfers to managed Agents, observed a managed transition, or tested exact-state survival across one. Those are still the next steps.

Finish the incomplete calibration with the improved evidence capture under a separately recorded continuation that carries this attempt's charges and unresolved reservation forward; do not silently give it another $2. Then apply the unchanged detector to controlled turns in one managed session, and challenge its original external state only after a confirmed transition. Repeat with the planned low-pressure controls. The eventual claim must remain “recovery after an observed context reduction” unless additional evidence distinguishes the hidden mechanism.

The current one-use claim remains closed. This report preserves a useful measurement result and a useful negative without promoting an unfinished study into proof of managed compaction.
