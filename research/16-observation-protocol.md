# Client observation protocol v9

OpenCnid freezes this protocol before new inference. The question is whether a client can detect a reproducible reduction in the context presented to a model, then recover exact application state in the same managed session. We cannot identify OpenAI's hidden mechanism uniquely.

## Claims and falsification

The primary detector uses total input tokens, including cached tokens, on small ACK turns. A candidate is the earliest drop meeting both a fractional and absolute threshold from the immediately preceding valid measurement, with two subsequent valid ACK measurements remaining below that same ceiling. The transition interval extends from the preceding measurement through the confirming measurement. Invalid or missing measurements break the sequence; they are never skipped to join distant observations. A plateau is not a drop.

Calibration selects the strictest successful rule from fractional thresholds 75%, 50%, 25% and absolute thresholds 2,048, 1,024 tokens, in that order. A successful development rule must detect known compaction and deliberate prefix deletion, and must never fire anywhere on the unchanged/full-history trajectory. Persistence is always two subsequent confirmations. The selected rule is written before held-out requests. Failure to find a rule stops the paid study as an inconclusive observation method. No threshold is retuned afterward.

Two independent held-out fixtures must both detect their known compaction and prefix-deletion transitions and produce zero full-history trajectory false positives. Otherwise, the detector fails calibration and no managed pressure is dispatched. These tiny counts assess feasibility, not a population error rate. A drop detector that detects deletion is explicitly **not compaction-specific**.

Recall is a separate descriptive measurement. An old task fact survives if its exact random answer is returned; adjacent irrelevant codes are scored separately. Old-task retention with recent controls working and different retention from deletion is evidence consistent with summarization, not proof. No recall result changes the usage threshold or rescues failed calibration. No managed task result changes whether a candidate exists.

## Responses calibration

Use one development fixture followed by two independently randomized held-out fixtures. Each has eight tool-free exchanges, each with 2,048 characters of irrelevant random hexadecimal text in an assistant message. Each exchange also contains a task-important arbitrary mapping and an adjacent irrelevant random code, in randomized order. Their answers are unavailable through application tools. The last two exchanges provide recent controls.

For each fixture, make two identical full-history ACK requests (shared pre-intervention baseline), one explicit `/responses/compact` call, then three ACK requests and one recall request for each of four arms:

| Arm | Post-intervention history |
| --- | --- |
| Full | The entire original history, plus tiny scheduled ticks |
| Compact | The entire canonical compact output, unchanged, plus those ticks |
| Prefix deletion | Original exchanges 7 and 8, plus those ticks |
| Rolling window | Original exchanges 7 and 8 initially; each following tick replaces the oldest retained exchange |

Ticks are client-authored tool-free messages. ACK outputs are measured but not appended, so each branch remains controlled. The first two repeated requests characterize cache effects. Each recall question is asked once per branch, after all usage measurements, for task facts and codes at exchanges 1, 4, 7 and 8. No recalled answers enter another measurement. Recall is a separate stateless request using that branch's last context. Identical questions across separate branches cannot refresh each other's histories. The full branch is the recall control; an unsuccessful full/recent control prevents interpreting retention differences.

There are exactly 19 paid requests per complete fixture, at most 57 calibration requests. ACK output cap: 256 tokens, including reasoning. Recall cap: 768. Responses requests use low reasoning, no tools, no retries, and `store:false`. Incomplete output is invalid, never a detection pass. Calibration stops at $0.50 reported cost or when its next reservation would exceed that allowance. Reserve $0.03 per response and $0.10 per compact call. These are stopping reservations, not guaranteed upper prices. A compact call has no reviewed output cap. Encrypted compaction items are retained; no normalization of their canonical input window is allowed.

## Conditional managed test

If calibration passes, use three independent pairs in order: low-pressure control, pressure session, repeated three times. One model and unchanged tool configuration throughout each session. Ordinary application functions only; no code tool, delegation, environment or web. No new session is substituted after setup.

Each session first discovers an application-owned task and completes its first of three jobs, using the v8 checkpoint storage and receipt checks. Freeze its completed receipt and leave two jobs pending. Bind all later turns to the same real server session ID and the frozen checkpoint. Tools permit rediscovery throughout, but measurement and recall turns explicitly forbid tool calls; a tool call invalidates a measurement and stops that case before any application operation.

Collect two short ACK baseline turns. Then append up to four blocks, each requesting only ACK. A pressure block contains 65,536 random hexadecimal characters; a control block contains 256. All blocks include randomized task facts and neighboring irrelevant codes. After an eligible drop, stop adding pressure and collect exactly two short ACK confirmations. If it fails persistence, stop this case as an unconfirmed candidate; do not hunt for another. If no eligible drop appears, finish the four doses and collect two short endpoint ACKs. The frozen detector scans that scheduled trajectory once, including endpoint samples. At most eight ACK turns per session. Never interpret absence of a drop at this dose as absence of compaction.

Record raw events, complete current session items, turn IDs and all usage revisions. Re-read turns after collection, up to three reads separated by one second, requiring two consecutive non-null equal usage records for the current completed turn. At the end of the study reconcile all managed turns read-only once more. A later changed usage record invalidates the online detection unless the identical candidate is still supported; report both. Billing uses high-water total/session counts, while measurement uses that turn's actual settled total, never cumulative usage or uncached tokens. ACK text must equal `ACK`; visible tool calls, multiple assistant final messages, retries, incomplete histories, missing usage or unfinished turns invalidate the sample. Public items do not certify the count of hidden generations; retain this limitation explicitly, with visible-generation count unavailable unless actually exposed.

After a confirmed candidate, ask a single held-out recall query about available block facts and codes, with recent controls. Do not ask whether compaction occurred. Then select two distinct external record indices randomly **after confirmation**, independently of the memory facts, and request exact retrieval plus completion of saved pending jobs. No old handle, result or pending list is included in that continuation. The original tools provide recovery. Low-pressure controls perform the same recall/recovery at their scheduled endpoint even if no candidate appears. Pressure sessions without a confirmed candidate do not perform a recovery challenge: survival remains inconclusive.

Primary recovery: eventual exact completion within one bounded turn, both pending operations performed once, no completed-job request repeated, original receipt and source intact, exact new records submitted. Incorrect intermediate arguments or reports can be corrected within limits and are reported separately. Recovery failure with intact storage and successful paired control is a workflow negative across an inferred context transition; it does not prove compaction caused the failure. A failed baseline, invalid telemetry, exhausted budget or unsuccessful setup makes the comparison inconclusive.

## Bounds, evidence and stopping

One exclusive `dispatch-observation-v9.json` claim covers this entire study. No resume command creates a fresh allowance. Pin `gpt-5.6-luna`, official `openai@7.15.0`, Node and pnpm versions; hash protocol, runner sources and lockfile in the manifest. Write learned detector parameters before any held-out calls and preserve raw requests/responses and hash-linked logs.

All calibration and managed calls share the user-authorized **$2 reported-usage stopping threshold**, with possible overshoot. Carry calibration charges into the managed guard. Reserve $0.20 before each managed turn; block the next turn if the shared allowance cannot admit it. Each managed session also has a $0.50 reported-cost stop. Missing terminal usage stops further paid dispatch. SDK retries are disabled. Each managed turn inherits the existing 120-second, 40-HTTP-request, 2,000-event, 8-MiB-log collector bounds and explicit cancellation on error. No more than six managed sessions and 66 managed turns (setup + eight ACKs + recall + recovery per session). Each recovery allows the existing six checkpoint calls and at most four additional record calls, with at most 24 KiB extra record outputs. A global 3,000-HTTP-request cap reserves 30 calls for read-only reconciliation/cancellation. All data are synthetic; no credentials go into evidence.

The final report separates observed token changes and exact results from the inferred context mechanism. A calibrated method, a null managed result, or a clean negative all count as findings. This protocol does not promise to reach a managed threshold for $2.

Sources: [the observation plan](15-managed-compaction-evidence-plan.md), [known Responses results](12-responses-compaction-results.md), [checkpoint results](14-checkpoint-resume-results.md), and [the pinned SDK/documentation audit](../evidence/documentation/2026-09-11-managed-compaction.json). The latter records why a service event is not assumed.
