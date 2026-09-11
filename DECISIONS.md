# Project decisions

## D001: We own exact state; OpenAI owns the agent loop

Recorded by OpenCnid on September 11, 2026. **Adopted as the working architecture for further managed-agent experiments.** This is not a decision to migrate the full RLM harness.

Keep source data, task identity, completed results and pending work in application-owned storage. Let OpenAI run the model/tool loop. Give the agent a stable way to rediscover its assigned task through an application tool such as `current_task_state()`.

Our application is the authority on what exists and what has completed. Model memory and model-written reports are not the authoritative record. Validate tool arguments, preserve completed receipts, and distinguish a repeated request from an operation that actually executes again.

### Evidence supporting the decision

In the [checkpoint study](research/14-checkpoint-resume-results.md), three new managed Agents sessions received none of the old conversation or task-specific identifiers in their initial requests. All three recovered their assigned task through the application binding and eventually completed the remaining jobs with exact results. No completed job was requested again. Three unbound controls reported blocked without accessing task data.

Every bound recovery needed error correction: two initially omitted old results from their reports; one mistyped a handle. Eventual recovery was 3 of 3, while the implementation's stricter error-free score was 0 of 3. These results demonstrate coexistence of application-owned exact state and a managed loop for this fixture; they do not establish general reliability.

The separate [Responses experiment](research/12-responses-compaction-results.md) recovered exact external records across three identified Responses compactions. That supports locator-based external storage, but it does not certify managed Agents compaction.

### What remains open

| Question | Status |
| --- | --- |
| Can exact application state coexist with the managed loop? | Demonstrated in the checkpoint fixture |
| Can a new session rediscover its task without the old conversation? | Demonstrated in 3 cases, with error correction |
| Does the workflow survive an identified managed-compaction boundary? | Unmeasured |
| Can native generated code delegate and consume child results with the required RLM semantics? | Unverified |
| Can this replace all current harness guarantees? | Not established |

The next evidence target is [recovery across an inferred managed-context transition](research/15-managed-compaction-evidence-plan.md), using client-side input-usage measurements and calibrated information probes. We will investigate without requiring a vendor event, while distinguishing an inferred compaction mechanism from observed recovery. A fresh-session reset, a long prompt, or a successful answer alone must not close the actual-compaction question.

The [completed observation study](research/23-managed-observation-results.md) passed calibration without changing the detector and ran three managed pressure/control pairs. All pressure sessions reached roughly 157,000–158,000 measured input tokens without the required sustained drop. None triggered a post-transition recovery challenge. All three controls completed their pending work and exact submissions; two have complete recovery evidence, while one retains an incomplete-collection qualification. D001 remains supported, but survival across managed compaction is still inconclusive. The next experiment must reach an observable transition before it can test that claim.

Calibration also showed that compaction and deliberate deletion both trigger the signal, and that recall can fail on freshly supplied information. Neither a token drop alone nor selective forgetting identifies the hidden mechanism. The study retained prior costs and reservations: $1.5993449 known estimated usage and $1.8293449 admission accounting against the original $2 stopping threshold.
