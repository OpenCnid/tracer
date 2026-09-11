# Correct the control setup and reserve delayed usage

Cohort `native-seam-v3` completed its first direct-delegation control with an incorrect submission, one completed child, and one failed child-creation item. The model said both calls were blocked, contradicting the completed child record. The request allowed only one active child while asking for two; this is a control confound. The public failed-call item does not contain an independent error explanation, so we do not promote the model's claimed cause into a verified runtime error.

The root's recorded usage was still null in the first follow-up read and became available in the next read. The two earlier attempts have a combined conservative estimate of USD 0.054622. This supports treating final accounting as delayed too; neither the initial null nor a completed turn is a final bill.

Cohort `native-seam-v4` is a separate nine-trial matrix, frozen before dispatch:

- Set native child concurrency to **two** in both native arms, matching the two requested child tasks. Keep all prompts, synthetic tasks, model, SDK, arm rotation, task grading and route-review criteria unchanged. This fixes a resource restriction in the control; it does not establish native delegation from generated code.
- Keep the USD 2 combined-study stopping threshold and USD 0.20 per-trial threshold, with the previously accepted possibility of overshoot. Carry USD 0.054622 from both earlier attempts into the starting estimate.
- Reserve USD 0.20 for a session while any observed root/child turn lacks usage, or while no turn has been observed. Use the greater of that reservation and its known cost estimate for further admission. Never equate null usage with zero cost. Known reported cost can still trigger immediate cancellation.
- After a terminal root outcome and complete history collection, missing final usage consumes that reservation rather than forcing immediate cohort abandonment. Admit another trial only if its USD 0.20 reservation fits the remaining combined-study threshold. Nine reservations plus prior accounting total USD 1.854622.
- Keep the 120-second trial deadline, ten-second usage polling, HTTP/tool/event/page limits, disabled SDK retries, explicit cancellation, and stopping on lifecycle, telemetry or history errors. Do not retry failed tasks or replace unsuccessful trials within the matrix.
- Collect late usage through read-only reconciliation after the cohort. Report provisional reservations, known estimates and unknown usage separately. Exact billed cost remains unavailable from these fields.

Retain v2 and v3 as unsuccessful calibration cohorts. Do not pool their controls with v4 or omit them from the report. If the native programmatic arm fails with working controls, retain that result without changing its prompt or substituting an application-created session bridge.

The prior accounting artifacts are `evidence/runs/2026-09-11T00-23-15-958Z-run-2424a128/reconcile-2026-09-11T00-25-28-815Z/result.json` and `evidence/runs/2026-09-11T00-27-58-269Z-run-ba7c9a60/reconcile-2026-09-11T00-31-43-493Z/result.json`. They and all preceding protocol documents are hash-bound by this cohort's preregistration.
