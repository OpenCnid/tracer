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

**Can code written by an agent launch built-in child agents, read their results, and continue computing with those results?**

Our probe compares ordinary delegation, code running without delegation, and code that delegates. We plan three trials of each. We check both the answers and execution records: a correct answer alone cannot show how the work happened.

## Current status

**Inconclusive. No live API experiments have run.**

The research and probe are in place, and 22 local tests passed. Our first attempt stopped because no API key was configured and we could not verify a hard spending limit that meets our experiment's budget rules. Local tests do not establish that the managed workflow works.

## Read the study

1. [Our reading and sources](research/01-reading.md)
2. [The experiment and what would disprove our hypothesis](research/02-preregistered-probe.md)
3. [How the probe works](research/03-implementation.md)
4. [Results and what remains unknown](research/04-results.md)

## Run locally

Use Node `^22.19.0 || >=24.0.0` and pnpm **11.7.0**. The official OpenAI SDK is pinned to **7.15.0**.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm probe plan
pnpm probe run
```

`probe run` currently records why the experiment is blocked and exits with an error without making paid requests. Adding an API key alone does not remove the spending-limit block.

See [setup and budget details](research/03-implementation.md) and [how to inspect the evidence](evidence/README.md) before running a live experiment.
