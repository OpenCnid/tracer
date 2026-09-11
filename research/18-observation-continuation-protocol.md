# Completing the observation study

OpenCnid authorizes this continuation after reviewing the interrupted [v9 results](17-observation-results.md). It completes the requested calibration and managed comparisons, carrying prior costs forward. It does not create a new $2 allowance or replace the earlier attempt.

## What stays fixed

Use `gpt-5.6-luna`, official `openai@7.15.0`, the existing synthetic fixtures and the detector locked in v9: at least a 50% and 2,048-token drop, with two subsequent valid confirmations. No new threshold selection. The source of `detect` is unchanged. Keep the [v9 protocol](16-observation-protocol.md)'s managed design: three control/pressure pairs, four 256-character control blocks or four 65,536-character pressure blocks, two initial and two confirming/endpoint ACKs, original session binding and checkpoint, and eventual exact recovery scoring.

No candidate means survival across a transition remains inconclusive. A candidate is a client-observed context reduction, not proof of a hidden compaction mechanism. Recall is descriptive and cannot certify discarded information. A successful answer cannot create a candidate.

## Complete the original calibration

The parent is `2026-09-11T13-13-03-969Z-context-observation-v9-d3b43f6e`. Verify its recorded source commit, logs, fixed detector, completed results and fixture hashes before dispatch. Preserve every parent file.

1. Repeat the second held-out fixture's unchanged full-history `pre-2` ACK request, byte-for-byte in its JSON body, as a bridge across the interruption. Require a completed ACK and total input usage within the larger of 128 tokens or 1% of its earlier 10,043 input tokens. Cache counts may differ. A failed bridge is an inconclusive accounting/control change and stops paid dispatch; it does not change the detector.
2. Reissue the failed prefix-recall request with the identical saved body. This is a new attempt with its own charge and identifier. The earlier unknown request remains unknown; never settle it using the replacement's usage.
3. Execute the three missing rolling-window ACKs and final rolling recall, reconstructed from the same saved fixture and tick values. Reuse completed measurements, not new random fixtures. ACK/recall token caps remain 256/768. There are at most **six new Responses requests**, including the bridge, and no new compact call.

Write the joined calibration with explicit source paths/hashes. Require all three scheduled fixtures complete and the original calibration rule satisfied before managed inference. The temporal gap is retained in the data. The bridge detects only obvious accounting drift; it cannot certify an unchanged backend. Fresh code recall was unreliable in v9 and is not a gate to task recovery.

## Managed comparisons

After calibration passes, run the six previously planned managed sessions. Use the original bounded collector and improved diagnostics; never replace a session after setup. For each session complete one job, freeze its receipt, and keep two pending. Measurement turns may not access tools. Check per-turn total usage, require two consecutive equal non-null reads within three one-second polls, and retain final read-only reconciliation.

On the first eligible drop, collect exactly two short confirmations and stop adding pressure. Use the unchanged detector to decide whether a candidate exists. If confirmed, query memory once, then randomly choose two external record indices and challenge the same session to recover its checkpoint, finish pending work and return exact records. Control sessions perform the same challenge at their scheduled endpoint. Pressure sessions without a confirmed candidate do not perform a survival challenge. No adaptive extra pressure is added to obtain a pass.

Keep the original six checkpoint calls and four record calls per recovery, 120-second and 40-HTTP-call bounds per turn, 2,000-event and 8-MiB-log caps, at most 66 managed turns, and explicit cancellation on collector failure. Before paid dispatch, test continuation accounting, reconstruction of missing requests, frozen rule/fixture validation, measurement eligibility and recovery verification. Raw Responses status, request ID and bounded body are now captured before SDK parsing. Managed SSE and read-only resources remain recorded by the collector.

Classify recovery from the final settled observations, actual stored bytes, original receipt hashes, report contents and effects. Eventual exact completion passes even after corrected arguments/reports, provided no completed-job request is repeated. Record first-attempt success separately. Unusable lifecycle/telemetry or damaged controls makes the comparison inconclusive, not a workflow failure. If a later usage revision changes the detected candidate, retain both decisions and do not assert survival across the original interval. Visible ACK-only items do not certify one hidden model call.

## One carried budget

The parent reports **$0.1328787 known estimated usage plus a $0.03 unresolved reservation**, so admission accounting begins at **$0.1628787**. The user explicitly requested carrying this unresolved reservation while continuing. This exception applies only to that historical request. No newly unresolved request authorizes further automatic paid dispatch.

Keep the total study's **$2 reported-usage stopping threshold**, with the previously accepted possibility of overshoot. Keep the combined calibration's $0.50 threshold, $0.03 reservation before each new Responses request, and no SDK retries. Carry the combined calibration accounting into managed inference. Reserve $0.20 before each managed turn and stop each session at $0.50 reported cost. Distinguish known cost from admission accounting: the historical $0.03 is a reservation, not an observed bill. Guard estimates that include it must be labeled accordingly.

A new exclusive `dispatch-observation-v10.json` links to the closed v9 claim and records the same total allowance. It blocks repeating this continuation. All 53 prior HTTP attempts count toward the existing 3,000-call ceiling. Retain original manifests and claims, source and protocol hashes, SDK/model versions, raw events and read-only replay. Publish the result even if the fixed doses produce no candidate. No new inference has occurred when this protocol is registered.
