# Luna study: USD 2 per invocation

This amendment records OpenCnid's request to use `gpt-5.6-luna` and limit a run to USD 2. It starts cohort `native-seam-v2`. A run means one invocation containing the planned nine trials, not USD 2 for each trial.

The original [experiment design](02-preregistered-probe.md) still defines the hypothesis, three arms, three rotated blocks, grading, route review, falsification and near misses. Its original SHA-256 is `21e6608516e0e341e0d1779d1dc3ba464f5bf6fb68b1500f2af2cefc12d22c49`. Both documents are bound into this cohort's preregistration. The earlier evidence remains unchanged.

Changes for this cohort:

- Request exactly `gpt-5.6-luna`, with low reasoning effort and default service tier. Keep the official SDK pinned to `openai@7.15.0`.
- Replace the strict ceiling with a USD 2 stopping threshold for the whole invocation. OpenCnid explicitly authorized: “Use the $2 stopping threshold; overshoot is acceptable.” Reserve USD 0.20 for each of nine planned sessions, totaling USD 1.80, and also stop a trial when its usage estimate reaches USD 0.20. These are client-side controls, not provider-enforced billing limits.
- Retain all existing request, tool, event, page and deadline limits.
- Use the locally configured credential. Do not retain its value or publish existing session content.

This explicitly replaces the original admission-time hard-spend requirement. Reported usage and cancellation can lag; costs can exceed either stopping threshold. No result may describe this as a guaranteed USD 2 ceiling.

The guard uses conservative Luna rates: USD 0.50 per million input tokens and USD 1.80 per million output tokens. These allow for the documented long-input multiplier and cache-write pricing, and do not discount cached input. Reasoning tokens are already included in output tokens. This estimate is not an invoice. [Model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Deduplicate usage snapshots by session and turn ID; retain the greatest observed counts so late downward revisions cannot reopen the budget. For each session, use the greater of its aggregate estimate and the sum of its distinct turn estimates, avoiding addition of the aggregate to its turns. Include child turns. Retain raw usage, including nulls.

Check reported usage on streamed turn events and by polling the current session and turns every ten seconds. Cancel if a stopping threshold is reached, a different model appears, telemetry fails, or no usable current-session usage is available after thirty seconds. The existing 120-second deadline remains a separate stop. Do not admit another paid session until the previous trial has finished and all observed turns have usable recorded usage. Missing final usage, incomplete history or uncertain cancellation stops the cohort and leaves it inconclusive. At most nine paid session creations are allowed, with SDK retries disabled and no replacement trials.

Keep the inference task, prompts and classification unchanged. Usage monitoring is a study safeguard; neither it nor read-only preflight counts as a successful native-delegation trial. A positive answer still requires the independent route evidence defined in the original design.

Before this amendment, one read-only session-list request succeeded with the newly configured key. It created no session and ran no model. Its manifest retains the old protocol and allocation because it was an access preflight under the previous runner, not a paid USD 2 study.
