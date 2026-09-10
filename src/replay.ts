import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decide, type RouteReview, type TrialEvidence } from './decision.js';
import { verifyLog } from './evidence.js';
import { sha256, type Trial } from './protocol.js';
import type { Collected } from './collector.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: pnpm replay <study-directory>');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { protocolHash: string; trials: Trial[] };
const verifiedRecords = verifyLog(join(directory, 'events.jsonl'));
const rows: TrialEvidence[] = [];
for (const trial of manifest.trials) {
  const trialDir = join(directory, trial.id);
  if (!existsSync(join(trialDir, 'collection.json'))) continue;
  verifyLog(join(trialDir, 'events.jsonl'));
  const collection = JSON.parse(readFileSync(join(trialDir, 'collection.json'), 'utf8')) as Collected;
  let review: RouteReview = { decision: 'unestablished' };
  const reviewFile = join(trialDir, 'route-review.json');
  if (existsSync(reviewFile)) {
    const annotation = JSON.parse(readFileSync(reviewFile, 'utf8')) as RouteReview & {
      protocolHash: string; sessionId: string; reviewer: string; artifact: string;
      artifactSha256: string; spanIds: string[]; basis: string;
    };
    if (annotation.protocolHash !== manifest.protocolHash || annotation.sessionId !== collection.sessionId ||
        !annotation.reviewer || annotation.basis !== 'independent-generation-and-tool-traces' ||
        !Array.isArray(annotation.spanIds) || !annotation.spanIds.length ||
        !['executed', 'runtime-rejected', 'unestablished'].includes(annotation.decision) ||
        typeof annotation.artifact !== 'string' || basename(annotation.artifact) !== annotation.artifact)
      throw new Error('INVALID_ROUTE_REVIEW');
    const artifact = join(trialDir, annotation.artifact);
    if (lstatSync(artifact).isSymbolicLink() || sha256(readFileSync(artifact)) !== annotation.artifactSha256)
      throw new Error('ROUTE_ARTIFACT_MISMATCH');
    review = annotation;
  }
  rows.push({ ...collection, block: trial.block, arm: trial.arm, review });
}
console.log(JSON.stringify({ verifiedRecords, collectedTrials: rows.length, ...decide(rows),
  caution: 'Hashes verify integrity, not truth. Execution-route decisions depend on reviewer trace interpretation.' }, null, 2));
