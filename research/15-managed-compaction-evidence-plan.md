# Observing managed context changes from the client

**Progress:** [The first implementation and calibration results](17-observation-results.md) are now available. The detector found known context reductions, recall proved ambiguous, and an unresolved request stopped calibration before managed testing. The design below remains the rationale; [v9](16-observation-protocol.md) is the frozen run protocol.

**OpenCnid will build a client-side detector instead of waiting for a compaction event from OpenAI.** We can measure changes in input usage and access to earlier information, calibrate those observations against known alternatives, and test our workflow across the inferred transition.

This replaces the earlier provider-dependent plan. It is a design, not a frozen paid-run protocol or a claim that managed compaction has already been observed. No new inference was performed for this revision. Our [decision to keep exact state in application storage](../DECISIONS.md) remains in place.

## Measure a controlled sequence

Feed one managed session fixed history blocks. Between blocks, send short, fixed-format requests for tiny acknowledgements. These measurement turns make no tool calls and do no application work.

Record **input tokens per measurement turn**, with cached tokens included in that total and also recorded separately. Do not use uncached tokens, price, or accumulated session usage as a context-size measurement. Retain output counts, message sizes, timing, model/tool settings and visible generation counts.

Look for a substantial, persistent downward change in input usage even though the application has continued adding history. Confirm the lower level with additional short turns without another large block. Record a transition interval, not an invented exact internal timestamp. Distinguish a drop from a plateau or slower growth.

A short turn with no tools reduces variation from model/tool loops. It does **not** prove exactly one internal model call. Exclude visibly retried or multi-generation samples from the primary measurement, and keep unobservable internal work as a limitation. Never divide usage by an assumed generation count. Reconcile delayed usage and retain its revisions before drawing conclusions.

## What our existing positive cases tell us

We re-examined the first lookup requests in the three known Responses compaction pairs:

| Pair | Input tokens with full history | After known compaction | Reduction | Exact old locator recovered |
| --- | ---: | ---: | ---: | --- |
| 1 | 9,759 | 689 | 92.94% | Yes |
| 2 | 9,818 | 659 | 93.29% | Yes |
| 3 | 9,791 | 698 | 92.87% | Yes |

These are retrospective contrasts from [the Responses experiment](12-responses-compaction-results.md), not new calls. [Derived values and source hashes](../evidence/analysis/2026-09-11-compaction-observation-baseline.json).

Input usage is therefore worth investigating. But **forgetting an exact random string cannot be a required sign of compaction**: all three known compact operations preserved the locator. These pairs do not validate a within-session detector, establish an Agents threshold, or distinguish compaction from truncation.

## Probe what information remains available

Place two kinds of information next to each other in older history blocks:

- Arbitrary task facts with exact expected answers, marked as important to future work.
- Short random strings with no task significance.

Rotate their positions. Later query held-out examples from several ages of history, plus recent examples that check ordinary answering still works. Randomize task facts so the answers cannot be reconstructed from common knowledge.

Retaining old task facts while losing neighboring irrelevant strings would be consistent with selective summarization. Losing both beyond a similar age would be consistent with prefix removal. Preserving both is also possible after compaction. Retrieval mistakes and selective history retrieval can overlap with these patterns; none uniquely identifies the mechanism.

Probe answers can copy old information into recent history. Query each held-out item only once, use separate matched groups before and after the candidate, and record every visible reappearance. Pressure replies should be tiny acknowledgements. Keep probe facts out of tools and the checkpoint store; the exact-state recovery test uses a separate dataset. Hidden reasoning could still restate facts, even when visible replies do not.

Do not ask the model whether it compacted or use its account of its context as detector input.

## Calibrate against alternatives

Use the same model, history fixtures and measurement questions in a small Responses calibration where the client controls supplied history:

| Control | History supplied | Purpose |
| --- | --- | --- |
| Full history | Complete history within the supported request size | Ordinary recall variation and input growth |
| Known compaction | Entire canonical output of `/responses/compact` | Positive compaction examples |
| Deliberate truncation | Remove an older prefix | Detect confusion with simple deletion |
| Rolling window | Retain a fixed recent portion | Detect saturation and repeated eviction |

Use tool-free calibration histories so truncation cannot break call/result pairs. Repeat unchanged histories to characterize cache and telemetry variation. Check recent-item recall to distinguish selective forgetting from general answer failure.

Separate development and held-out calibration cases. Set the detector's drop threshold, persistence rule and candidate-selection rule on development cases; evaluate that frozen rule on held-out controls before applying it to Agents. Measure false positives across the **whole scheduled trajectory**, since repeatedly searching for a drop creates more opportunities to find noise. Freeze all doses and sample limits before inspecting managed outcomes.

If the detector also labels deliberate truncation as compaction, that is a useful negative. Narrow its claim to **context reduction**. Do not tune against the managed result until it passes. Responses calibration also cannot establish undocumented Agents accounting semantics; matched low-pressure Agents sessions must assess whether the measurement transfers.

## Apply it to the managed workflow

1. **Save unfinished work.** Complete one job, leave known jobs pending and freeze original receipts in application storage. Keep the same session and server-side binding throughout.
2. **Collect the trajectory.** Add fixed history blocks and interleave controlled measurement turns. Save full requests, raw events, settled per-turn usage, visible tool/generation counts and unchanged configuration.
3. **Detect a candidate independently.** Apply the frozen usage rule without looking at task success. Retain the interval and competing explanations. Use held-out information probes to characterize retention.
4. **Challenge afterward.** Select new external record indices after the candidate is confirmed. Ask that same session to retrieve them and continue its saved task. Supply no old handle, completed result or pending-job list, and no new compaction warning or recovery hint.
5. **Verify and repeat.** Check original receipt hashes, selected records and operation effects. Separate duplicate attempts and intermediate mistakes from eventual exact completion. Use three independent managed cases and matched low-pressure baselines, within fixed spending and sample limits.

An acknowledgement is not task recovery. Conversely, recovery success must not be an input to the detector: that would make the argument circular. If another transition occurs during the challenge, retain the uncertainty rather than assigning success to one precisely located boundary.

Using the original checkpoint tool counts as recovery of the application-backed workflow. It does not establish unaided preservation of the old locator.

## Conclusions the evidence can support

| Observation | Permitted conclusion |
| --- | --- |
| Calibrated, persistent usage drop with valid checks | Client-observed change consistent with reduced active context |
| That change plus retention distinguishable from held-out deletion controls | Stronger evidence consistent with summarizing compaction, with alternatives stated |
| Exact task recovery after the inferred transition | Workflow survived the observed transition in these cases |
| Incorrect recovery after a usable transition measurement, with intact storage and working baselines | Workflow failure after that transition; compaction causality remains inferred |
| Detector cannot distinguish compaction from deletion | Context reduction may be observable; compaction-specific identification failed |
| No candidate, unstable usage, broken controls or budget exhausted before comparison | Inconclusive for the intended survival claim |

The primary recovery criterion is eventual exact completion within fixed limits, with pending operations executed once and no repeated completed-job request. Record first-attempt accuracy separately, and make the implementation and protocol agree on those definitions.

**We are changing how we gather evidence, not claiming access to the hidden implementation.** Retrieval, selective context assembly or another hidden mechanism can produce observations similar to summarization. Report the boundary as inferred and the recovery outcome as observed. A failure can reject the fixed workflow's reliability across the measured transition without proving compaction caused it.

## Immediate next work

Implement controlled measurements and calibration, then freeze a new run protocol. Provider confirmation is optional corroboration, not a prerequisite. Keep `gpt-5.6-luna` and `openai@7.15.0` pinned.

A paid study needs one shared $2 reported-usage stopping allowance, an exclusive dispatch claim, fixed calibration and managed-run limits, carried reservations and final read-only reconciliation. If that allowance cannot reach a detectable transition, report the limitation rather than silently enlarging the study. This design has not dispatched such a study.

The [existing documentation/SDK audit](../evidence/documentation/2026-09-11-managed-compaction.json) explains why no direct marker is assumed. [Our reading of long-context evaluation](01-reading.md) explains why forgetting alone is unreliable. Neither replaces detector calibration.
