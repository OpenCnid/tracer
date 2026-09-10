# Independent reading

The team's conclusion and experiment were deliberately withheld. This review does not infer either. It distinguishes the feasibility of the inference pattern, a port using native managed children, and replacement of the existing harness's operational guarantees. These are different decisions.

## What the required sources establish

**Paper facts.** In RLM v3, input is an external object, generated code makes recursive calls over constructed slices, and intermediate values and final output can remain in the environment. Algorithm 2 explains why adding ordinary subagent tools is insufficient. Root history still grows; bounded per-iteration output does not establish an infinite root horizon. Table 1 includes depth ablations with model-dependent benefits. Appendix B reports prompt sensitivity, coding failures, output-token exhaustion, slow sequential calls, and brittle finalization. Appendix E includes a run that constructed an answer but ultimately emitted a wrong one. Its compaction baseline is a particular implementation, including a cheaper summarizer for GPT-5; it is not an evaluation of this managed API. These facts support testing execution semantics before downstream accuracy. [Zhang, Kraska and Khattab, v3, May 11, 2026, §§2–7 and appendices](https://arxiv.org/html/2512.24601v3).

**Reference-code facts.** The current repository is not frozen to the paper experiment. At commit `854e688fbba9d8f8989e3da9989812e4b6dfe270`, `RLM` has optional compaction: it summarizes root history and retains history in the external environment. The implementation also differs in its final-answer mechanism. This is direct counterevidence to the claim that RLM categorically forbids compaction. It is not evidence that OpenAI's implementation behaves identically. [RLM loop](https://github.com/alexzhang13/rlm/blob/854e688fbba9d8f8989e3da9989812e4b6dfe270/rlm/core/rlm.py), [external environment](https://github.com/alexzhang13/rlm/blob/854e688fbba9d8f8989e3da9989812e4b6dfe270/rlm/environments/local_repl.py).

**Managed API facts.** OpenAI runs the model/tool loop, sessions, compaction, and recovery. The application provides tools and chooses compute. `environment: none` still supports application function tools; a self-hosted executor does not transfer ownership of the harness to the customer. [Overview](https://developers.openai.com/api/docs/guides/agents-api/overview), [architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture).

Sessions retain work across turns, but session durability and executable state are separate. Self-hosted replacement compute does not recover files merely by reusing its environment ID. Hosted files survive while the sandbox exists; published output artifacts have a separate lifetime. Neither is a promise of a persistent Python namespace. [Sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions), [lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle), [hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), [files](https://developers.openai.com/api/docs/guides/agents-api/environments/files).

Programmatic Tool Calling (PTC) is enabled by default in the Agents API and can process intermediate tool output before returning information to the model. The documented V8 runtime is fresh per program, with no filesystem, Node runtime, or persistent JavaScript variables. External tools can provide durable state. The guide says existing tools are available to generated code, but does not explicitly specify the native delegation tools' programmatic signatures, their return/wait semantics, or whether child results bypass parent model context. Responses API `allowed_callers` examples are explicitly a different integration. [PTC](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).

Native multi-agent support supplies create/message/wait/interrupt tools. Children have separate contexts and share an attached filesystem. Children inherit MCP capabilities but do not support application function tools. The concurrency limit is not a total-child or token limit. The docs do not give a complete context-inheritance contract. [Multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent).

The general compaction guide documents **Responses** controls, including a threshold and a standalone compact endpoint. It does not establish that `client.beta.agents.sessions.create` accepts those fields, or that its internally managed compaction is the same operation. The reviewed Agents creation schema exposes neither a compaction threshold nor a trigger. No documented compaction-completion event was found in the pinned Agents event union. An input-token decrease or an assistant saying it compacted is not proof of a compaction boundary. [Compaction](https://developers.openai.com/api/docs/guides/compaction), [create-session reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/create).

Saved items are history, not a guaranteed reconstruction of every rendered model input. Streams do not replay missed events. The public API cannot retrieve detailed generation traces; the dashboard has recorded generation/tool spans. Usage is best effort, can be null, and can change after completion. Command truncation is not reported. This limits what a black-box experiment can establish. [Events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events), [observability](https://developers.openai.com/api/docs/guides/agents-api/observability), [tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing).

## My interpretation

RLM's external data access and the managed harness's history reduction address different bottlenecks. The former decides how much source material and intermediate computation need to become tokens at all; the latter decides what to retain from tokens already admitted. They are complementary if exact source/state can be revisited through stable handles. Lossy history reduction cannot serve as authoritative storage for exact intermediate values.

A useful decomposition is:

| Layer | Needed property | Implication for this decision |
| --- | --- | --- |
| Input and intermediate objects | Exact, addressable bytes outside model context | Application storage or a persistent tool runtime can provide this. |
| Programmatic recursive computation | Generated programs construct calls and collect results without transcribing each through the root model | Native managed delegation needs verification. |
| Root working history | Bounded working context and usable continuation | Compaction can help; it need not retain every data byte. |
| Operational authority | Admission, budget, lineage, cancellation, recovery, policy | Moving the model loop does not automatically move all these guarantees. |

The broad question admits a constructive answer: an application tool can operate on an external store and start bounded leaf inference, returning only a handle. That can retain RLM-style dataflow without controlling the root model's context manager. However, an application-owned recursive-session bridge takes responsibility for admissions, ancestry, cancellation and result delivery. It is a different migration from relying on native managed children.

The existing bundle has a meaningful stronger invariant: DSH remains the model-loop and native-child authority. Its preview includes persistent kernels and snapshot restoration without replay. Its architecture document explicitly labels additional process machinery as **planned**, so I do not count those plans as deployed functionality. [DeepSeek RLM README](https://github.com/OpenCnid/deepseek-rlm/blob/0e9f030300f9e5b37b76cdcd3d39bc490a251e79/README.md), [architecture](https://github.com/OpenCnid/deepseek-rlm/blob/0e9f030300f9e5b37b76cdcd3d39bc490a251e79/ARCHITECTURE.md).

My provisional recommendation is to explore a narrow managed adapter, while withholding a claim of a faithful native port. A persistent Python tool, file store, or session wrapper can restore missing capabilities, but the amount of operational machinery it restores determines whether the migration actually removes maintenance work.

## Additional sources that change the analysis

These are primary sources, used for mechanisms and experimental cautions. Their historical benchmark scores are not forecasts for September 2026 models.

1. **MemGPT** makes a useful distinction between external storage and the model's actual prompt, and combines retrieval with queue eviction and a recursive summary. My inference: exact storage and lossy working history are compatible; preserving a file alone does not mean the model can find it. [Packer et al., v2, February 12, 2024, §2](https://arxiv.org/html/2310.08560v2).
2. **Lost in the Middle** varies both input length and evidence position. My inference: inability to recall a planted string cannot prove it never entered context. Any later admission probe needs positive recall controls and should rotate evidence position. [Liu et al., v3, November 20, 2023, §§2–4](https://arxiv.org/html/2307.03172v3).
3. **RULER** includes retrieval, multi-hop tracing, aggregation and QA, with distinct error modes beyond single-needle retrieval. My inference: a nonce round trip is a transport probe, not evidence of long-context semantic competence. [Hsieh et al., v2, April 11, 2024, §§3–5](https://arxiv.org/html/2404.06654v2).
4. **Context-Folding** uses branch/return sub-trajectories with intermediate steps folded away, and trains the behavior with FoldGRPO. My inference: isolated delegation and a short parent history can be effective without satisfying symbolic recursion; a good final answer cannot identify which mechanism ran. [Sun et al., 2025, authors' method and results page](https://context-folding.github.io/).
5. **ReSum** replaces accumulating search histories with periodic structured reasoning summaries and trains summary-conditioned continuation. My inference: compaction quality is a learned operational behavior, not a conservation law; neither its success nor failure settles exact external-state handling. This is the 2025 search paper, not the similarly named 2026 work. [Wu et al., September 2025, §3](https://arxiv.org/html/2509.13313v1).
6. **Anthropic's context-engineering account** describes just-in-time references, compaction, persistent notes and separate subagent contexts. My inference: these are composable choices, with different recall and latency tradeoffs. [Rajasekaran et al., September 29, 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
7. **Anthropic's managed-agent architecture** separates harness, durable session and sandbox. It explicitly describes the session as an external context object and allows the harness to transform retrieved events. My inference: vendor-managed execution is not intrinsically incompatible with externalized context, but a durable log is not an exact model-input transcript. This is corroborating architecture from another vendor, not an OpenAI guarantee. [Martin, Cemaj and Cohen, April 8, 2026](https://www.anthropic.com/engineering/managed-agents).

## What could specifically break

- Native child tools may be unavailable inside generated programs, forcing the root to verbalize each call or requiring an application bridge.
- A child might receive inherited context beyond the selected slice; separate context does not imply empty context.
- Child completion text may automatically enter the root's history even when the application wants only a handle. A small-answer test cannot establish bounded scaling.
- Compaction might lose a locator, an outstanding job ID, or the next action. Exact values can remain safe while useful continuation fails.
- Sandbox loss, tool-result replay, and a late child write are operational failures that can corrupt apparent continuation independently of compaction.
- The customer cannot currently reproduce the full managed context policy from public items or pin the service implementation by pinning the SDK.

These are hypotheses or contract gaps, not observed failures of the service.
