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

We first tested whether an agent could delegate two jobs and collect their answers. We then tested whether it could recover an earlier storage handle and retrieve exact records in a later turn, including under context pressure. We check tool records and stored bytes independently of the model's account of what happened.

## Current status

**Exact external-state retrieval passed all three follow-up tests. Survival across compaction remains unproven.**

Each session received a handle to an external file larger than 1 MiB. A later turn requested two newly selected records without repeating the handle. Two sessions also received 640 KiB of irrelevant text to put pressure on context.

| External-state test | Exact retrieval |
| --- | --- |
| Short session | Passed |
| Pressure trial 1 | Passed |
| Pressure trial 2 | Passed |

The agents recovered their earlier handles and submitted the exact records. The external files stayed unchanged. However, the API and inspected dashboard traces did not establish that compaction occurred, so these passes cannot certify post-compaction behavior.

The revised delegation test also improved collection: two of three trials requesting delegation from code submitted both assigned children's answers. Other failures involved omitted task inputs and incorrect reversals. The inspected traces still do not expose the executing JavaScript, so a faithful native RLM port remains unverified.

The complete follow-up used a **$2 stopping threshold** with accepted possible overshoot. Its conservative usage estimate is **$1.38**, not a final bill. [Read what happened and what it means](research/10-followup-results.md). The [earlier study](research/08-live-results.md) remains unchanged.

## Read the study

1. [Our reading and sources](research/01-reading.md)
2. [The experiment and what would disprove our hypothesis](research/02-preregistered-probe.md)
3. [How the probe works](research/03-implementation.md)
4. [Current results: external state, collection and compaction](research/10-followup-results.md)
5. [The follow-up protocol](research/09-followup-protocol.md)

## Run locally

Use Node `^22.19.0 || >=24.0.0` and pnpm **11.7.0**. The official OpenAI SDK is pinned to **7.15.0**.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm followup plan
pnpm followup run
```

`followup run` makes paid requests when a key is configured in `.env`. After its collection gate passes, reconcile usage and pass that accounting artifact to `state-probe`; the second stage carries the first stage's spending into the same $2 allowance. The threshold is not a guaranteed billing cap: usage and cancellation can be delayed.

See [setup and budget details](research/03-implementation.md) and [how to inspect the evidence](evidence/README.md) before running a live experiment.
