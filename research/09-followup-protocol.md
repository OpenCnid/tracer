# Follow-up: collect every child, then test external state

OpenCnid's question remains: **can exact external state remain usable when OpenAI manages the agent's context?** The previous trial tested a prerequisite and did not answer that question. This follow-up separates a collection repair from a test of external-state access under context pressure. Neither is a full RLM benchmark.

This protocol is frozen before new paid requests. Model `gpt-5.6-luna`, SDK `openai@7.15.0`, Node and pnpm requirements remain unchanged. Earlier runs are historical evidence and are not pooled with this follow-up.

## Newly available trace evidence

After the operator signed in, we inspected all six generation spans and the wait span of v4's first native-from-code trial. The dashboard's raw JSON exposes nested fixture, spawn, wait and submit items, but no executing JavaScript, program item or program-to-child caller identifier. The returned wait span has `result: null`. These are observations about this recorded turn, not a guarantee that all dashboard traces omit programs. The span files are retained in `evidence/trace-reviews/v4-b1-native`.

Consequently, source repeated by the model is only **reported source**. We will ask for it and retain it, but will not certify execution from it. This corrects our earlier expectation that signing into the dashboard would necessarily supply the missing program. Dashboard generation inputs also appear as incremental recorded items; they are not a certified full rendered model input.

## Stage A: explicit collection (`collect-all-v5`)

Run three fresh pairs of direct-native and programmatic-native sessions, rotating order. Keep the two 32-character reversal tasks, fixture, answer checker, model, child concurrency of two, and 120-second deadline. The earlier code-without-delegation control was 3/3; it is not repeated here because this intervention changes collection, not local reversal.

Both current arms must maintain the set of outstanding child IDs. A wait can return a subset. Inspect actual runtime return values, save each completed final answer under its child ID, remove only completed children, and continue waiting for the remainder. At most six waits per child; no new child, rerun, local reversal or substituted route. Never convert a missing value into a string and submit it. If a completed value cannot be extracted, report the actual observed shape and stop.

In the programmatic arm this logic must run inside generated code. Ask the model to include the exact submitted JavaScript afterward, explicitly labeled reported source. Match trace spans to persisted calls where possible. If actual program/caller evidence is absent, retain route attribution as unestablished, even with correct answers.

Keep two separate measures:

- **Task correctness:** both submitted strings match the reversal oracle.
- **Collection agreement:** each submitted value equals the corresponding child's completed final answer. A wrong child answer can agree with submission; it is a task error, not missing transport. This does not prove code performed the collection.

Our repair hypothesis is falsified operationally if the revised native workflow again submits a missing value or fails to collect both completed answers within these bounds. An incorrect child transformation alone does not falsify the collection repair. Three native trials with complete agreement support only this finite collection behavior. Native availability still requires execution evidence; no categorical API rejection is inferred from a prompt failure.

## Stage B: exact external state (`external-state-v6`)

Run this separate component test after Stage A if at least two native trials collect both final answers, even if native route attribution remains unavailable. This gate establishes a useful coordination result, not a faithful RLM port. If Stage A does not reach that gate, stop paid work and report the failing prerequisite.

Three new conversation-only sessions use application function tools and managed PTC: one short-session control followed by two pressure trials. Each gets an immutable external file with 512 random records of 2,048 hexadecimal characters each (over 1 MiB including JSON). None of those values is included in initial instructions. During setup, a manifest tool returns only a random opaque handle and record count. The agent must retain the handle for later work.

After setup completes, the runner independently selects two record indices. The next user message supplies the indices, but **does not repeat the handle or data**. The agent must use its earlier handle to read those records and submit their exact values through tools. The handler reopens the external file, checks its original hash, and rejects a wrong handle; it cannot silently repair a forgotten locator. Query selection and file integrity are independently recorded. Tools cannot enumerate handles or recreate the manifest during lookup.

For the short control, that lookup message is small. Each pressure lookup additionally contains exactly 640 KiB of fresh synthetic hexadecimal data, clearly labeled as irrelevant context-pressure data, followed by the same lookup instruction. This is one fixed treatment dose, not an adaptive search for a pass. No extra filler turns, retries, model change, manual summary, or Responses `/compact` substitution.

The same managed session performs setup and lookup. Native children are disabled in this component test so a retrieval failure cannot be blamed on child arithmetic or waiting. It tests an RLM requirement—addressing exact external data with a retained locator—not recursive inference itself.

### What can and cannot be concluded

Record independently: setup completion, selected indices, exact read arguments, external file hash before and after, returned bytes, submitted values, terminal states, reported usage, dashboard spans, and any observable compaction marker. Model claims, a token-count fall, a successful lookup, and long input alone do not establish compaction.

- A completed lookup with matching values and unchanged file is a pass for **external-state retrieval in that session**.
- Failure with an intact file and working short control is a negative **pressure-workflow** result. Inspect whether the failure is locator loss, incorrect copying, truncation, context rejection, budget cancellation, or another cause; do not label all of these compaction failures.
- **Compaction survival is supported only if both pressure trials have independently established managed compaction after manifest creation and before lookup, and both retrieve the exact selected records.** The short control must work.
- The hypothesis that the locator remains usable is falsified for the tested workflow by a verified post-compaction locator failure, with unchanged accessible state and a working control. One such failure is evidence against reliability; two strengthen it. It does not show every adapter is impossible.
- No observable boundary means **compaction survival remains inconclusive**, regardless of retrieval success. Exhausting the fixed dose is not permission to keep inflating context.

The pinned Agents SDK has no compaction input command, threshold, program item, or compaction-completed event in the reviewed unions. The public compaction guide's controls describe Responses. We will inspect live events and dashboard spans for positive boundary evidence without inventing undocumented fields. If traces still omit the boundary, the important outcome is a measurement limit on answering the original question.

## One spending allowance for both stages

The operator previously accepted a **USD 2 reported-usage stopping threshold with possible overshoot** and requested this follow-up. USD 2 covers all new work in Stages A and B together, not each invocation or trial. It is a new follow-up allowance; the already published v4 study is not rerun or charged against it.

Stage A admits at most six sessions with USD 0.20 per-session thresholds. Before Stage B, perform read-only usage reconciliation; carry the full conservative admission estimate, including reservations for missing counts. Stage B admits at most three sessions: USD 0.15 for the short control and USD 0.70 for each pressure session, including both setup and lookup. Admit a session only if its reservation fits the remaining USD 2. Missing usage does not count as zero. If the next reservation does not fit, stop with a budget-limited result.

Use the existing conservative rates (USD 0.50/M input and 1.80/M output), ten-second usage checks, explicit cancellation and 120-second deadlines per turn. Counts can arrive late and may include descendant rollups; estimates are not invoices. Stage B has at most two root turns per session, no native children, one manifest call during setup and one read plus one submit during lookup. Function output remains capped at 16 KiB per turn. Keep the HTTP/evidence caps and separate cleanup reserves for each turn. SDK retries remain disabled. No top-up or replacement trial is automatic.

## Sources checked for this follow-up

- [Agents tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing): recorded spans, incremental evidence limitations, no public external exporter.
- [Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling): fresh V8 state and the distinct Agents/Responses integrations.
- [Managed architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture): application functions and vendor-owned harness.
- [Compaction](https://developers.openai.com/api/docs/guides/compaction): the explicit controls are for Responses.
- [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna): context limits, pricing and long-input multipliers.

The final report will lead with what this changes about external-state/context compatibility. Collection scores, route evidence and spending are supporting facts rather than substitutes for that answer.
