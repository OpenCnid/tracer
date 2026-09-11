import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {verifyLog} from './evidence.js';
import {sha256} from './protocol.js';
import {decideState, type StateObservation} from './state-decision.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: pnpm state-replay <external-state-study-directory>');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
if (manifest.protocol !== 'external-state-v6') throw new Error('WRONG_PROTOCOL');
let verifiedRecords = verifyLog(join(directory, 'events.jsonl'));
const observations: StateObservation[] = [];
const summaries: unknown[] = [];
for (const trial of manifest.trials) {
  const path = join(directory, trial.id);
  if (!existsSync(join(path, 'result.json'))) continue;
  verifiedRecords += verifyLog(join(path, 'events.jsonl'));
  verifiedRecords += verifyLog(join(path, 'setup/events.jsonl'));
  if (existsSync(join(path, 'lookup/events.jsonl'))) verifiedRecords += verifyLog(join(path, 'lookup/events.jsonl'));
  const summary = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8'));
  const info = JSON.parse(readFileSync(join(path, 'state-info.json'), 'utf8'));
  const stateIntact = sha256(readFileSync(join(path, 'external-state.json'))) === info.expectedSha256;
  let boundaryVerified = false;
  const reviewPath = join(path, 'boundary-review.json');
  if (existsSync(reviewPath)) {
    const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
    if (review.protocolHash !== manifest.protocolHash || review.sessionId !== summary.setup.sessionId ||
        review.basis !== 'service-observed-compaction' || !review.reviewer ||
        review.boundaryAfterSetupBeforeLookup !== true || !Array.isArray(review.spanOrEventIds) || !review.spanOrEventIds.length ||
        typeof review.artifact !== 'string' || basename(review.artifact) !== review.artifact)
      throw new Error('INVALID_BOUNDARY_REVIEW');
    const artifact = join(path, review.artifact);
    if (lstatSync(artifact).isSymbolicLink() || sha256(readFileSync(artifact)) !== review.artifactSha256)
      throw new Error('BOUNDARY_ARTIFACT_MISMATCH');
    boundaryVerified = review.decision === 'observed';
  }
  const row = {pressure: summary.pressure, retrievalCorrect: summary.retrievalCorrect, stateIntact,
    boundaryVerified, locatorFailure: summary.lookup?.error?.localReason === 'INVALID_STATE_HANDLE'};
  observations.push(row); summaries.push({trial: trial.id, ...row});
}
console.log(JSON.stringify({verifiedRecords, trials: summaries, ...decideState(observations),
  caution: 'Integrity checks do not prove the meaning of a trace; boundary annotations require independent service evidence.'}, null, 2));
