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

**The tested native-from-code workflow failed all three answer checks.** We completed a nine-trial matrix on `gpt-5.6-luna`, after two separately recorded calibration attempts.

| Workflow | Correct submissions |
| --- | --- |
| Code without delegation | 3 of 3 |
| Direct child-agent delegation | 2 of 3 |
| Child-agent delegation requested from code | 0 of 3 |

The native-from-code trials created two children but submitted an undefined value after a wait returned only one child's result. This points to incomplete result collection. It does **not** prove that the API cannot support RLM: the exact execution route still needs independent trace review, and one control also failed a string transformation.

The runner uses a **$2 stopping threshold**, with possible overshoot explicitly accepted by OpenCnid. The latest conservative estimate for all attempts is **about $0.37**, not a final bill. [Live results and evidence](research/08-live-results.md).

## Read the study

1. [Our reading and sources](research/01-reading.md)
2. [The experiment and what would disprove our hypothesis](research/02-preregistered-probe.md)
3. [How the probe works](research/03-implementation.md)
4. [Live results and what remains unknown](research/08-live-results.md)

## Run locally

Use Node `^22.19.0 || >=24.0.0` and pnpm **11.7.0**. The official OpenAI SDK is pinned to **7.15.0**.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm probe plan
pnpm probe run
```

`probe run` makes paid requests when a key is configured in `.env`. It runs trials sequentially, monitors reported usage, and stops on budget or evidence problems. The $2 threshold is not a guaranteed billing cap: usage and cancellation can be delayed. An unreviewed run exits with an inconclusive result.

See [setup and budget details](research/03-implementation.md) and [how to inspect the evidence](evidence/README.md) before running a live experiment.
