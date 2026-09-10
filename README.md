# tracer

An independent review of RLM-style inference on OpenAI's managed Agents API. The team's conclusion and experiment were deliberately withheld. This repository records this reviewer's reasoning and a separately preregistered probe.

**Current answer:** RLM's externalized dataflow and managed compaction are compatible in principle. A faithful port using native managed children remains unproven. The first unresolved interface is whether generated code can invoke native children on constructed inputs and consume their returned values inside the program.

**Empirical status: inconclusive.** No real managed sessions or paid inference requests were made. The local environment has no API credential, and the reviewed API/SDK exposes no verified spending bound that satisfies the frozen protocol. These are execution gates, not evidence that native recursion fails. The requirement for repeated real runs remains outstanding.

Read in the requested order:

1. [Reading, additional sources and interpretation](research/01-reading.md)
2. [Chosen unknown, alternatives, falsification and near misses](research/02-preregistered-probe.md)
3. [Small probe implementation and evidence review](research/03-implementation.md)
4. [Observed results, limitations and decision](research/04-results.md)

The study contains three controls/experimental arms across three rotated blocks. Correct answers alone cannot establish the execution route. The scorer requires independently reviewed runtime traces, and preserves supported, refuted and inconclusive outcomes separately. It does not infer a compaction boundary from token counts or model self-report.

## Reproduce the local evidence

Use Node `^22.19.0 || >=24.0.0` and pnpm **11.7.0**. The official OpenAI SDK is pinned to **7.15.0**, with a committed dependency lockfile.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm probe plan
pnpm probe run
```

The probe's `run` command currently exits **2**, writes structured inconclusive evidence, and dispatches no inference; a package-manager wrapper may return **1** while reporting the underlying code 2. This is deliberate enforcement of the budget contract. A new documented spending bound, or an explicitly revised spending contract, requires a new protocol; there is no bypass flag. `pnpm replay <evidence-directory>` checks log integrity and recomputes the conservative classification.

Copy `.env.example` to `.env` to configure credentials locally. This workspace already has an ignored, empty `.env`; creating that file does not create an API key. Do not commit credentials. An optional `pnpm probe preflight --online` performs at most one read-only access check when a credential is present.

See [evidence provenance](evidence/README.md) and the [source manifest](research/sources.json). Hashes establish artifact integrity, not the truth of model statements or reviewer annotations. No external source cache, private trace, credential or dependency directory is published.
