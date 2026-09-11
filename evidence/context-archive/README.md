# Context archive verification

`verification.json` is a receipt from **offline replay**, using a previously published real Agents transcript. It is not a new live-model experiment.

The final run imported 238 stream events and 49 saved items from 284 evidence records. It saved and loaded the archive, supplied a shorter synthetic working history, and retrieved an earlier 151-character message exactly through `context_search` and `context_read`. The recovered SHA-256 matches the source record. An empty-archive control returned no matches. The largest tool reply was 857 bytes.

All six recorded checks passed. The component suite also passes 19 new tests; the repository total is 109. There were **zero new API calls or inference charges**. The receipt records Node 24.19.0, pnpm 11.7.0 and the pinned OpenAI SDK 7.15.0.

Reproduce from the repository root with a new destination:

```sh
pnpm check
pnpm context-demo evidence/runs/2026-09-11T14-53-15-103Z-context-observation-v10-last-11441bae/b1-control/11-recovery/events.jsonl .tracer/context/review-demo
```

The command leaves the original and restored archives, snapshot, negative control and receipt in that private directory. Replays have different capture timestamps, conversation IDs and journal heads; the original source hash and recovered text hash should remain the same. Earlier development checks are retained locally under `.tracer/context/`; this receipt comes from the final implementation's verification run.

The evidence supports local persistence and retrieval independently of simulated working-history contents. It does not measure a live model's decision to search or establish an actual managed-compaction boundary. See the [context manager documentation](../../docs/context-manager.md) and [existing research outcome](../../research/23-managed-observation-results.md).
