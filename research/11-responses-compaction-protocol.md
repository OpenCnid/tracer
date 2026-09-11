# A controlled Responses compaction test

OpenCnid will test a component of its RLM approach: can a model recover an exact external-state locator after explicit OpenAI compaction? This uses Responses, not the managed Agents API. It cannot determine when an Agents session compacts or whether the two services use the same mechanism.

This protocol is frozen before paid requests. Model `gpt-5.6-luna`, official SDK `openai@7.15.0`, Node and pnpm requirements are unchanged. No model substitution, replacement trial, prompt repair, adaptive pressure or automatic paid retry.

## Three paired trials

1. Each pair gets a fresh immutable file: 512 random records of 2,048 hexadecimal characters, over 1 MiB total. The application records the file hash and a fresh opaque handle.
2. A real Responses generation requests `tracer_manifest`. The application returns the handle, record count and exactly 16 KiB of irrelevant synthetic hex notes. No record value is supplied. A second generation acknowledges setup. Instructions ask it to retain the handle for future access but not echo it.
3. Call `/responses/compact` once with the complete setup history and the same general instructions. Save the complete request and response, request ID, usage and compaction item. There is no pressure threshold search: this is an explicit compaction operation on a small fixture.
4. Only after compaction returns, select two random record indices. Both arms receive the same query, with no handle or record values added. The control uses the full setup history. The treatment uses the **entire canonical compact output unchanged**, including any retained messages. Neither branch uses `previous_response_id`, a Conversation, or the other branch's outputs. Responses are stateless (`store:false`); encrypted reasoning is preserved for normal history continuation.
5. Each branch has at most two further model requests: one to request `tracer_state_read` using the earlier handle, then one to submit its exact returned records with `tracer_state_submit`. Native children and programmatic tool calling are absent: this isolates locator recovery. The application checks file integrity, indices and returned bytes, and separately checks the model's submitted values. Tool or model errors are retained; no locator correction or manifest reissue is possible.

Lookup order rotates: control/treatment, treatment/control, control/treatment. A single setup and single compact operation belong to each pair; the three pairs are independent fixtures, not six independent compactions. There is no unregistered search for a better prompt.

## Outcomes fixed in advance

Keep these observations separate:

- **Boundary established:** a successful `/responses/compact` result contains an identified nonempty encrypted compaction item; that entire result is the next treatment input prefix.
- **Visible handle retained:** search every readable string in the returned items (including arguments and messages), excluding opaque encrypted contents. Record paths, not just a boolean. The same check covers instructions and query; neither may introduce the handle.
- **Locator recovery:** one valid model-generated read call uses the original exact handle and selected indices; the immutable file hash matches and the handler returns the exact oracle records.
- **Submission correctness:** the model submits those records unchanged. Incorrect copying is distinct from locator loss.

A successful treatment with an established boundary and no visible handle supports recovery from the returned compacted context for this fixture. It does not reveal the encrypted representation or prove a particular compression algorithm. A successful treatment with a visible handle is a valid continuation pass, but **inconclusive for recovery through opaque compacted state**. Never prune a retained message to make the evidence look stronger.

The hypothesis that the locator remains usable is falsified for this tested workflow by an explicit wrong/missing handle in the treatment, provided the paired control works, the boundary and exclusive context are established, and the file is intact. Repeated failures strengthen that result. A wrong final data copy alone does not falsify locator recovery. Full support for the fixed cohort requires all three controls and treatments to recover the locator, and all three treatment boundaries to exclude a visible handle. Report individual results even when the cohort is incomplete.

Missing compaction items, unsupported endpoint/model, input rejection, transport ambiguity, incomplete generation, missing usage, budget exhaustion or a broken control produce an inconclusive result for the affected claim. Stop the study on API/transport/accounting errors; do not paper over beta behavior. Completed behavioral failures do not cause replacement trials.

## Bounded spending and evidence

This is a new **shared USD 2 reported-usage stopping threshold**, with possible overshoot already accepted by OpenCnid. It is not USD 2 per pair or invocation. Before the first request, write an exclusive dispatch claim; rerunning the command cannot reset this allowance. Up to 21 paid requests: three compactions and eighteen Responses generations. No paid request runs concurrently.

Reserve USD 0.30 before each compact request and USD 0.05 before each ordinary generation. Replace a reservation only with valid returned usage priced conservatively at USD 0.50/M input and USD 1.80/M output (cache discounts ignored). Missing/uncertain usage keeps the reservation and stops new paid work. These are admission reservations, not guaranteed per-request ceilings. Refuse admission when estimate plus reservation exceeds USD 2; stop if reported total reaches USD 2. `/compact` has no reviewed output-token limit, so this retains the user's accepted overshoot limitation. Every request has a 120-second client deadline and SDK retries disabled. A client timeout does not prove server cancellation; report any ambiguous call and stop.

Ordinary generations cap output at 1,024 tokens for setup/read and 8,192 for data submission. Bound each request body and each response body to 256 KiB. There are at most two function executions per lookup and no external paid tools. The compact request uses `service_tier:default`; the regular requests use the same tier and low reasoning effort. Record actual model when returned; absence on the compact object is reported rather than invented.

Save protocol/source/lockfile hashes, SDK and Node versions, requests/responses, immutable files, tool calls/results, selected indices, retained-handle paths, classification and usage in reviewable artifacts. Preserve historical Agents results. Local tests must cover the service boundary vs visible-handle distinction, wrong locator vs copying error, paired-control requirement, exact preservation of compact output, no cross-arm context, and budget refusal/missing-usage behavior.

## Sources checked before implementation

- [Standalone compaction](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint): canonical returned window must be passed as-is; retained items may accompany encrypted state.
- [Compact API reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/compact): request parameters, object and usage. This endpoint does not take an Agents session ID.
- [Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna): Responses support, token prices and long-input/cache-write multipliers. SDK inclusion of Luna is not itself proof that compact is enabled for this account; the real request tests availability.
- [Managed Agents overview](https://developers.openai.com/api/docs/guides/agents-api/overview): the separate harness manages compaction; this experiment does not observe its internal boundary.
