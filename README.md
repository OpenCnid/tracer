# tracer

OpenCnid's investigation into a practical question: **Can we run Recursive Language Model (RLM) workflows on OpenAI's managed Agents API?**

## What is the managed Agents API?

An agent needs software that coordinates model calls, tools, and ongoing work. That software is called a **harness**.

The [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) gives applications access to a managed Codex harness. OpenAI runs the agent loop, saves sessions, coordinates subtasks, and handles recovery. It also summarizes earlier work to fit the model's limited working memory, a process called **context compaction**. We supply tools and choose where code runs.

For OpenCnid, this could mean less infrastructure to maintain. Our [deepseek-rlm](https://github.com/OpenCnid/deepseek-rlm) project currently relies on a harness whose agent loop we control. Moving to a managed service means giving up some of that control. We want to know whether our workflows still work before making that move.

## Where RLM fits

[Recursive Language Models](https://arxiv.org/html/2512.24601v3) use model-written code to inspect large inputs, call other models on selected parts, and combine their results. The full input and intermediate results can stay outside the model's prompt.

Our reading is that RLM and managed compaction can work together. The unresolved part is whether the managed service exposes the operations this workflow needs.

## What we're testing

Our central concern is **whether exact external data remains usable when OpenAI manages and compacts the agent's working memory**.

We first tested delegation and external-state retrieval in managed Agents sessions. We then tested explicit compaction through Responses, and recovery from a saved checkpoint in completely new managed Agents sessions. We check tool records and stored bytes independently of the model's account of what happened.

## Current status

**We have a candidate signal for context reduction, but have not yet tested it on managed Agents. Survival across the harness's own compaction remains unproven.**

The newest experiment compared known Responses compaction with full history and deliberate deletion. All three measured compacted branches showed a persistent token drop, but deletion did too. The detector can flag a reduction; it cannot identify the hidden mechanism. A request failed before the last calibration fixture finished, so no managed sessions were launched. Known usage was about **13 cents**, with one request's usage unresolved. [What the detector found, and what stopped the test](research/17-observation-results.md).

Recall also proved misleading: compacted branches omitted a random code even when we supplied it visibly after compaction. An incorrect answer cannot tell us that the harness removed the information.

In the earlier checkpoint test, an agent completed one of three jobs. We saved its result, started a new session with no old conversation, and let it discover its assigned task through `current_task_state()`. All three new sessions found the checkpoint and finished only the remaining jobs. None repeated completed work. Three controls with no task binding correctly reported that they were blocked.

Two recoveries initially omitted the old job's result from their reports; the third mistyped a handle. All corrected their errors after tool feedback. The implementation's strict workflow score was therefore **0 of 3**, while eventual exact recovery was **3 of 3**. [Read what happened, including the scoring qualification](research/14-checkpoint-resume-results.md).

| Experiment | Observed result | Managed compaction established? |
| --- | --- | --- |
| Managed Agents: short control and two pressure sessions | 3 of 3 exact retrievals passed | No |
| Responses: explicit compaction, with paired controls | All 3 compacted branches and all 3 controls passed | Explicit Responses compaction only |
| Managed Agents: fresh sessions with saved checkpoints | All 3 tasks eventually recovered; all 3 needed error correction | No; these were deliberate session resets |
| Context detector: controlled Responses histories | Token drops after compaction and deletion; final calibration fixture incomplete | No managed sessions dispatched |

Our working decision is **we own exact state; OpenAI owns the agent loop**. Application storage holds the source data, completion status and task locator, and the session can rediscover that state through a tool. [The decision record](DECISIONS.md) preserves the evidence and limits: this is demonstrated for the checkpoint fixture, with error correction, and is not a full RLM migration decision.

Our next step is to finish calibration, then use the fixed detector in controlled managed sessions and test exact recovery after an inferred transition. [The evidence plan](research/15-managed-compaction-evidence-plan.md) distinguishes observations from claims about OpenAI's hidden implementation; a service-generated marker is not a prerequisite. The stopped attempt's costs and reservation must carry forward into any continuation.

The revised delegation test also improved collection: two of three trials requesting delegation from code submitted both assigned children's answers. Other failures involved omitted task inputs and incorrect reversals. The inspected traces still do not expose the executing JavaScript, so a faithful native RLM port remains unverified.

The latest checkpoint study used nine sessions and a shared **$2 stopping threshold**. Its reconciled estimate was **$0.178804**, about 18 cents. The [Responses study](research/12-responses-compaction-results.md) had a separate ten-cent estimate. These are conservative usage estimates, not final bills; all earlier results remain available.

## Read the study

1. [Our reading and sources](research/01-reading.md)
2. [The experiment and what would disprove our hypothesis](research/02-preregistered-probe.md)
3. [How the probe works](research/03-implementation.md)
4. [Latest results: context detector calibration](research/17-observation-results.md)
5. [The checkpoint recovery protocol](research/13-checkpoint-resume-protocol.md)
6. [Exact state after Responses compaction](research/12-responses-compaction-results.md)
7. [The Responses compaction protocol](research/11-responses-compaction-protocol.md)
8. [Managed Agents follow-up results](research/10-followup-results.md)
9. [Checkpoint recovery in fresh managed sessions](research/14-checkpoint-resume-results.md)
10. [The context observation protocol](research/16-observation-protocol.md)

## Run locally

Use Node `^22.19.0 || >=24.0.0` and pnpm **11.7.0**. The official OpenAI SDK is pinned to **7.15.0**.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm observation-probe plan
pnpm observation-replay evidence/runs/2026-09-11T13-13-03-969Z-context-observation-v9-d3b43f6e
```

These commands inspect the plan and replay published evidence without paid inference. Each completed study's one-use dispatch claim blocks another paid run, so rerunning it cannot silently reset the spending allowance. Live studies require a key in `.env` and their own authorized accounting. The stopping threshold is not a guaranteed billing cap.

See [setup and budget details](research/03-implementation.md) and [how to inspect the evidence](evidence/README.md) before running a live experiment.
