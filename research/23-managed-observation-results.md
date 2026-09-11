# Testing the detector in managed Agents sessions

**We completed calibration and all six planned managed sessions. We did not detect a managed context transition, so survival across managed compaction remains inconclusive.**

- **Calibration passed** with the original detector unchanged.
- **All three pressure sessions reached about 157,000–158,000 input tokens without the required drop.** No post-transition recovery challenge was triggered.
- **All three controls completed the two pending jobs and submitted both exact external records correctly.** Two have complete recovery evidence; one retains an incomplete-collection qualification.
- **Known estimated usage was $1.60; admission accounting was $1.83**, including $0.23 in carried unresolved reservations, under the original $2 stopping threshold.

OpenCnid continued the interrupted study under its original $2 reported-usage stopping allowance. We kept the detector, model, SDK, history doses and recovery checks fixed. We did not start a new allowance when the runner encountered an error.

## What we tested

Each managed session starts a three-job task, completes one job and saves its exact result externally. Two jobs remain pending. The session then receives short acknowledgement requests interleaved with history blocks. Controls receive four small blocks; pressure sessions receive up to four blocks of 65,536 random hexadecimal characters each.

We measure total input tokens, including cached tokens. The frozen detector requires a drop of at least 50% and 2,048 tokens that stays below that ceiling for two further measurements. It sees no recovery scores. Only after a confirmed drop does a pressure session receive its recovery challenge: finish the two pending jobs and return two randomly selected external records exactly. Controls receive the same challenge at their scheduled endpoint.

This tests a prerequisite for the original RLM direction: whether application-owned exact state remains usable through a context change while OpenAI runs the agent loop. It does not test a full recursive workload or establish all the guarantees needed to replace our existing harness.

## Calibration completed

The continuation made six Responses requests: a bridge to the earlier unchanged history, the interrupted recall request, and four missing rolling-window requests. The bridge returned **10,043 input tokens**, exactly the earlier count. All three original fixtures now complete the calibration gate, including the two held-out fixtures. The detector remains unchanged.

Known compaction and deliberate deletion both trigger the detector; full history does not in these fixtures. That supports a context-reduction measurement, not a compaction-specific label. The earlier recall problem also remains: a model sometimes omitted a random code visibly supplied after compaction. The newly completed rolling-window branch also returned `null` for its freshly supplied code, without any compact call in that branch. Forgetting cannot certify discarded context.

## Managed outcomes

| Case | First → final measured input tokens | Confirmed drop | Recovery result |
| --- | ---: | --- | --- |
| Control 1 | 7,848 → 8,870 | No | Exact recovery verified |
| Pressure 1 | 7,864 → 157,152 | No | Not challenged: no transition |
| Control 2 | 7,790 → 8,766 | No | Exact effects/submissions; collection incomplete |
| Pressure 2 | 7,846 → 157,475 | No | Not challenged: no transition |
| Control 3 | 7,776 → 8,771 | No | Exact recovery verified |
| Pressure 3 | 7,929 → 157,899 | No | Not challenged: no transition |

All **48 ACK measurements** were valid. Each case kept the same real session ID and configuration. Final reconciliation did not change any measurement's usage. All six sessions were idle, with no pending tool actions and known usage for all **60 distinct managed turns**.

The first pressure trajectory shows what happened: **7,864 → 7,890 → 45,276 → 82,464 → 119,780 → 157,100 → 157,126 → 157,152**. Input grew with each large block, then changed only slightly on the tiny endpoint requests. The other pressure cases followed the same pattern.

Caching is a concrete near miss: the first pressure endpoint reported 157,152 total input tokens, of which 157,123 were cached. Its 29 uncached tokens cannot be read as a 29-token working context. Our detector uses the total.

In every control, the two pending jobs executed once, the completed job was never requested again, the original receipt and source bytes remained intact, and the first checkpoint and record submissions were accepted. Independent replay verifies complete recovery evidence for controls 1 and 3. Control 2's original collection lacks a terminal event and complete history; later public resources show its turn completed, but we preserve the collection qualification. **Exact application effects were 3/3; complete recovery evidence was 2/3.** All three paired survival comparisons remain inconclusive, because none observed a transition; pair 2 also has the collection qualification.

[Full trajectories and independent recovery replay](../evidence/analysis/2026-09-11-observation-v10-final-replay.json).

## What this means for the original RLM question

The external-state workflow continues to work in these controls. **We still cannot say it survives actual managed compaction.** The required transition was never observed, and we deliberately did not substitute ordinary successful retrieval for that missing evidence.

This is a negative result for **this fixed pressure schedule as a way to expose a transition**. It is not evidence that compaction never occurred or that RLM is impossible on Agents. A gradual reduction, a smaller drop, a change masked by newly added input, or hidden generation accounting could escape this detector. None of those mechanisms was established here.

The next high-value experiment should focus on reaching an observable boundary in one session, with a predeclared larger pressure schedule and enough reserved budget for confirmations and recovery. Keep the same checkpoint and freeze the detector before that study. Repeating these same three four-block pressure cases offers little new information. Do not lower the threshold after seeing these null results and then count that as validation. A sustained drop would still establish context reduction rather than identify compaction specifically.

## Operational findings

We encountered several interruptions before the first control finished. The original records remain preserved; subsequent observations are separate files.

- **Usage can arrive after a turn finishes.** Three short reads were insufficient. We registered a bounded extension to 18 reads, five seconds apart, still requiring consecutive equal non-null usage.
- **A failed stream does not prove failed execution.** One request returned `internal_error`, yet its exact input later appeared as a completed ACK turn in the same session. We adopted the public result after matching its input, output, configuration and usage. We did not repeat that task input.
- **A read failure can hide successful task work.** Controls 1 and 3 had complete successful recovery collections, followed by failed read-only usage requests. Independent replay verified their completed results from original receipts and tool records; the original runner errors remain visible.
- **Task effects and collection completeness are different checks.** The second control also submitted both reports correctly, but its collector lacked a terminal event and complete history. Its public turn later showed completed. We preserved that collection failure instead of rerunning the task or promoting it into a clean comparison.
- **Retries need their own accounting.** A separate unestablished ACK request used the registered same-idempotency retry. We retained a $0.20 reservation rather than assuming the failed transport was free. Read-only GET retries are bounded, logged and counted against the existing network limits; paid POSTs have no automatic SDK retry.

These are collection and recovery findings. They neither create a context-transition candidate nor excuse an incorrect task result. Limited diagnostics do not establish whether the earlier errors arose in the network, SDK, client or service. The operational addenda were recorded before each resumed paid stage: [settlement](19-managed-usage-settlement-addendum.md), [transport](20-managed-transport-addendum.md), [completed-turn adoption](21-adopt-completed-turn-addendum.md), [remaining cohort](22-finish-managed-cohort-addendum.md), [final comparisons](24-complete-remaining-pairs-addendum.md), and [last pressure case](25-final-pressure-addendum.md).

## Cost and evidence

All stages share the original $2 stopping allowance. The completed study has **58 saved Responses results from 59 attempts**, plus **60 distinct managed turns across six sessions**. Copied evidence and resumed runners are not additional sessions. There were 936 total HTTP attempts including carried calibration, streaming requests, tool-result submissions and read-only operations; this is not a count of hidden model calls.

Known calibration usage totals 273,035 input / 3,072 output tokens. Managed usage totals 2,877,998 input / 10,166 output tokens. At the frozen conservative rates, their combined estimate is **$1.5993449**. Adding the original $0.03 unknown-request reservation and the $0.20 unestablished-transport reservation gives **$1.8293449 for admission accounting**. No new managed turn has missing usage. Reservations are not observed charges, and neither number is a final invoice or guaranteed upper bill. [Independent accounting calculation](../evidence/analysis/2026-09-11-observation-v10-accounting.json).

The model is **gpt-5.6-luna**, official SDK **7.15.0**, Node **24.19.0**, pnpm **11.7.0**. The manifest records the exact source commit and file hashes for each stage. The detector source is unchanged from registration. **90 local tests pass**, alongside TypeScript checking. Final replay verifies 76 hash-linked logs containing 3,217 records, source hashes, exact task effects and unchanged measurements. These log counts include inherited evidence; local tests are not service observations. A post-run replay fix makes the carried detector rule explicit when a continuation has no new detector-lock file; it does not alter the detector or any live result.

[Final manifest](../evidence/runs/2026-09-11T14-53-15-103Z-context-observation-v10-last-11441bae/manifest.json) · [Final collection result](../evidence/runs/2026-09-11T14-53-15-103Z-context-observation-v10-last-11441bae/result.json) · [Completed calibration](../evidence/analysis/2026-09-11-observation-v10-calibration.json) · [Local test report](../evidence/local-tests/vitest-v10.json).

One development qualification: an adoption stage started despite a TypeScript generic-inference diagnostic because a PowerShell command sequence did not stop on a failed check. The subsequent fix added only a type annotation. An [emitted-JavaScript comparison](../evidence/local-tests/v10-adoption-typing-fix.json) verifies identical executable output. Later dispatches were gated on successful checks. This does not erase the original failed check.

[Original protocol](16-observation-protocol.md) · [Continuation protocol](18-observation-continuation-protocol.md) · [Original interrupted results](17-observation-results.md)
