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

We first tested delegation and external-state retrieval in managed Agents sessions. We then used the separate Responses API to test retrieval across an explicit, observable compaction. We check tool records and stored bytes independently of the model's account of what happened.

## Current status

**Exact external-state retrieval survived explicit Responses compaction in all three paired trials. Survival across the managed Agents harness's own compaction remains unproven.**

In the latest test, the model received a handle to an external file larger than 1 MiB. We called `/responses/compact`, then requested newly selected records without repeating the handle. Each compacted context contained an encrypted compaction item and the original user request; no readable handle remained. The model still recovered the handle and submitted the exact records. All three uncompacted controls passed too.

| Experiment | Exact retrieval | Compaction established? |
| --- | --- | --- |
| Managed Agents: short control and two pressure sessions | 3 of 3 passed | No |
| Responses: explicit compaction, with paired controls | 3 of 3 compacted branches passed; 3 of 3 controls passed | Yes |

This supports keeping exact data in application storage while carrying its locator through compacted context. It does not establish that managed Agents uses the same mechanism or preserves the locator under its own context policy. [Read the latest result and evidence](research/12-responses-compaction-results.md).

The revised delegation test also improved collection: two of three trials requesting delegation from code submitted both assigned children's answers. Other failures involved omitted task inputs and incorrect reversals. The inspected traces still do not expose the executing JavaScript, so a faithful native RLM port remains unverified.

The Responses experiment used a shared **$2 stopping threshold** and finished at a conservative estimate of **$0.09623**, about ten cents. The earlier [managed Agents follow-up](research/10-followup-results.md) had its own $1.38 estimate. These are not final bills; all earlier results remain available.

## Read the study

1. [Our reading and sources](research/01-reading.md)
2. [The experiment and what would disprove our hypothesis](research/02-preregistered-probe.md)
3. [How the probe works](research/03-implementation.md)
4. [Latest results: exact state after Responses compaction](research/12-responses-compaction-results.md)
5. [The Responses compaction protocol](research/11-responses-compaction-protocol.md)
6. [Managed Agents follow-up results](research/10-followup-results.md)

## Run locally

Use Node `^22.19.0 || >=24.0.0` and pnpm **11.7.0**. The official OpenAI SDK is pinned to **7.15.0**.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm compact-probe plan
pnpm compact-replay evidence/runs/2026-09-11T03-10-48-421Z-responses-compact-v7-3a77cf0c
```

These commands inspect the plan and replay published evidence without paid inference. `compact-probe run` is blocked by the completed study's one-use dispatch claim, so rerunning it cannot silently reset the spending allowance. Live studies require a key in `.env` and their own authorized accounting. The stopping threshold is not a guaranteed billing cap.

See [setup and budget details](research/03-implementation.md) and [how to inspect the evidence](evidence/README.md) before running a live experiment.
