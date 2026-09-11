# Establishing survival across actual managed compaction

OpenCnid's next step is to **identify a real compaction boundary in a managed Agents session, then test that same session afterward**. The missing evidence is the boundary. We already demonstrated exact application storage and fresh-session recovery in [the checkpoint study](14-checkpoint-resume-results.md).

This is an evidence plan, not a frozen paid-run protocol. No inference was started for this review, and it does not create a new spending allowance.

## What we checked on September 11, 2026

The [Agents overview](https://developers.openai.com/api/docs/guides/agents-api/overview) says OpenAI manages compaction. That establishes the architectural responsibility, not when a particular session compacted.

The [current create-session reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/create) and our pinned `openai@7.15.0` schema expose no reviewed compaction threshold or trigger. We inspected the session creation/update parameters and event, input and item unions. A supplementary search across all 26 TypeScript files in the Agents resource subtree found no compaction/context-management terms. This is a statement about the reviewed public surface; undocumented service behavior could exist. [Version, file hashes, unions and documentation retrieval metadata](../evidence/documentation/2026-09-11-managed-compaction.json).

The [tracing guide](https://developers.openai.com/api/docs/guides/agents-api/tracing) documents recorded generation inputs and outputs, with traces built after a turn ends. It does not promise that every recorded input is the complete model context or identify a compaction span. The [observability guide](https://developers.openai.com/api/docs/guides/agents-api/observability) says trace retrieval and external exporters are outside the public beta API. Saved [events and items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events) serve live progress and conversation history; those interfaces do not establish a compaction-completion signal.

Our earlier [pressure-session trace reviews](10-followup-results.md) found no identifiable boundary. Repeating the same inspection or simply adding more filler does not resolve that measurement gap.

## First establish what counts as proof

We need a service-generated record that identifies **completed compaction of the root context**, belongs to our exact session, and can be placed before the model generation used to answer our challenge. Acceptable evidence could be:

1. A documented service event or item with those semantics, if OpenAI exposes one.
2. A raw dashboard trace showing an identified compaction operation and linking its result to the subsequent root generation. A label or an unexplained summary is insufficient; its meaning and ordering must be established.
3. Session-specific confirmation from OpenAI identifying the compaction operation and the first root generation that used the resulting context. Save that confirmation as provider-attested evidence, distinct from an API-observed event.

None of those signals is currently established for our managed runs. If a new field appears, preserve its raw payload and verify its meaning before treating it as a boundary. An operation in a child context does not prove the root compacted. A started or failed compaction does not prove the tested generation used compacted state.

Lower input-token usage, cache changes, latency, a missing nonce, the model saying it compacted, and exceeding an assumed context size are supporting observations at most. Each has other explanations. Counting all tokens used across a turn is not measuring one model input. A separately created `/responses/compact` item also does not identify compaction inside a managed session.

## Then run a test that can fail

Once the signal is understood, freeze the exact protocol, model, SDK, prompts, tool behavior, limits and scoring **before** new inference. Start with three independent cases and matched low-pressure baselines. If no compaction signal exists, baseline absence of a signal must not be promoted into proof that no compaction happened.

1. **Prepare and verify state.** In one managed session, finish one job, leave known work pending, save exact results outside context, and freeze the checkpoint hashes. Establish a successful lookup before applying pressure.
2. **Cross the measured boundary.** Continue that same session through a fixed, bounded workload, or use a supported managed-harness trigger if OpenAI provides one. Do not replace the session or inject a Responses compaction object. Retain the raw event and trace evidence. Because traces can arrive after a turn ends, a completed pressure turn can be inspected before sending the challenge.
3. **Challenge after the boundary.** Select new random record indices only after boundary confirmation. Ask for those exact records and continuation of the saved task without repeating the handle, completed results or pending-job list. Keep the original tool configuration and instructions. Do not tell the model that compaction occurred or give an extra recovery hint in the primary test.
4. **Check the actual work.** Verify source and receipt hashes, read arguments, records retrieved, pending-job selection and operation counts. Require the challenge generation to occur after the identified boundary. A later boundary cannot validate an earlier successful read. Record whether the agent used retained context or rediscovered state through its tool when the evidence can distinguish them.
5. **Repeat within the frozen limits.** Keep all cases, errors and missing boundaries. Do not replace awkward trials or increase the pressure dose until a result passes. A separate, explicitly prompted recovery arm can measure assisted recovery, but must not rescue the primary result.

Using the checkpoint tool after compaction counts as survival of the **application-backed workflow**. It does not prove that the model retained its old locator unaided. Those are separate hypotheses.

## Keep three measurements separate

| Measurement | Recorded result |
| --- | --- |
| Did the tested root generation follow verified managed compaction? | Verified / unestablished, with the raw evidence and provenance |
| Did exact task recovery finish within the fixed limits? | Completed correctly / failed / inconclusive |
| What mistakes occurred along the way? | Invalid arguments, duplicate attempts, prevented duplicate effects, report omissions and retries |

The primary recovery criterion is eventual exact completion within the preregistered limits, with every pending operation executed once and no repeated completed-job request. Report first-attempt correctness separately. Make the implementation and protocol agree on that distinction; the checkpoint study's stricter implementation score must not be repeated as an accidental second definition of success.

**Evidence supporting survival:** verified root compaction precedes the challenge; the same session recovers the correct external state, preserves original results and completes pending work under the stated criterion. This supports the tested boundaries, not every possible compaction or full RLM behavior.

**A clean negative:** with a verified boundary, intact storage, valid tools and a working baseline, the completed workflow cannot recover the task, uses incorrect state, repeats completed work, or fails to complete within its fixed model/tool allowance. That falsifies the claim that this fixed workflow succeeds in every tested case. It does not by itself prove compaction caused the failure; baseline errors and model variability remain possible explanations. Causal attribution would be stronger with a supported trigger that can be randomized while other conditions stay fixed.

**Inconclusive:** no verified boundary before the challenge, missing trace data, API/lifecycle failure, broken storage or binding, or spending/deadline exhaustion before the intended comparison. Store any observed retrieval success or failure separately. Never score an unobserved compaction as a passed compaction test.

## The immediate next action

Obtain the missing observability contract from OpenAI before buying a larger pressure run. Our existing session records provide concrete examples for that discussion. A generic statement that the harness compacts is insufficient; we need a field or attestation tied to an actual session and generation.

Draft for OpenAI's Agents API team, **not sent**:

> We are testing exact external-state recovery on managed Agents with `openai@7.15.0` and `gpt-5.6-luna`. Which service event, item or dashboard field identifies completed root-context compaction, and how can we identify the first model generation that consumed the resulting context? Are generation-span inputs complete model inputs or selected recorded items? Is there a supported trigger or lower threshold for a bounded experiment? For a concrete example, can you confirm whether session `sess_037bc373fd2c12b9006aa35f1b9c2c81918190448a71df90b4` compacted, with the relevant operation and generation IDs?

That example is our already-recorded [first pressure session](../evidence/trace-reviews/v6-s2-pressure/review.json), not a new run. If provider evidence cannot be made reviewable, report that limitation rather than claiming public reproducibility.

The next paid protocol should retain the authorized style of **$2 shared reported-usage stopping threshold**, with possible overshoot, an exclusive study claim, carried reservations, fixed pressure/turn/tool limits and read-only final reconciliation. It needs its own study authorization; the earlier allowances remain closed. SDK changes or newly available telemetry must be recorded as a new study condition.
