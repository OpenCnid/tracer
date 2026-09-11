import OpenAI from 'openai';
import {randomInt, randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {authorizePaidInference, boundedFetch, UsageGuard} from './budget.js';
import {collectTrial, type Collected} from './collector.js';
import {Evidence, safeError, verifyLog} from './evidence.js';
import {claimStateStage, followupRegistration, implementationHashes, STATE_PROTOCOL} from './followup-protocol.js';
import {DEFAULT_MODEL, LIMITS, SDK_VERSION, sha256, type Trial} from './protocol.js';
import {StateLedger, StateStore, RECORD_COUNT} from './state-store.js';
import {stateQuery, stateRequest} from './state-protocol.js';
import {auditSdk} from './sdk-audit.js';

const [mode, priorFile] = process.argv.slice(2);
if (!['plan', 'run'].includes(mode ?? '') || !priorFile || process.argv.length !== 4)
  throw new Error('Usage: pnpm state-probe [plan|run] <Stage-A-reconciliation-result.json>');
if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.OPENAI_API_KEY?.trim() ?? '';
const model = process.env.TRACER_MODEL?.trim() || DEFAULT_MODEL;
const registration = followupRegistration(); const audit = auditSdk();
if (!audit.versionMatches || model !== DEFAULT_MODEL) throw new Error('SDK_OR_MODEL_CHANGED');
if (mode === 'run' && !key) throw new Error('MISSING_OPENAI_API_KEY');
authorizePaidInference('reported-usage-stop');
const previous = JSON.parse(readFileSync(priorFile, 'utf8')) as {
  readOnly: boolean; sdk: string; budget: {admissionEstimateUsd: number}; summaries: unknown[];
};
const sourceDirectory = dirname(dirname(resolve(priorFile)));
verifyLog(join(sourceDirectory, 'events.jsonl')); verifyLog(join(dirname(resolve(priorFile)), 'events.jsonl'));
const sourceManifest = JSON.parse(readFileSync(join(sourceDirectory, 'manifest.json'), 'utf8'));
const sourceResult = JSON.parse(readFileSync(join(sourceDirectory, 'result.json'), 'utf8'));
if (sourceManifest.protocol !== 'collect-all-v5' || sourceManifest.protocolHash !== registration.protocolHash ||
    sourceManifest.modelRequested !== model || !sourceResult.stateGate || previous.readOnly !== true ||
    previous.sdk !== SDK_VERSION || previous.summaries.length !== sourceResult.summaries.length ||
    !Number.isFinite(previous.budget.admissionEstimateUsd) || previous.budget.admissionEstimateUsd < 0)
  throw new Error('INVALID_PRIOR_ACCOUNTING_OR_COLLECTION_GATE');

const seed = randomUUID();
const evidence = new Evidence(join('evidence/runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${STATE_PROTOCOL}-${mode}-${seed.slice(0,8)}`), [key]);
const trials: Trial[] = ['control', 'pressure', 'pressure'].map((kind, i) => ({
  id: `s${i+1}-${kind}`, arm: 'programmatic-local', block: i+1, seed: sha256(`${seed}:${i}`), model,
}));
let carriedUsd = previous.budget.admissionEstimateUsd;
evidence.write('manifest.json', {protocol: STATE_PROTOCOL, ...registration, mode, seed, trials,
  modelRequested: model, sdk: SDK_VERSION, node: process.version, pnpmUserAgent: process.env.npm_config_user_agent ?? null,
  priorEstimateUsd: carriedUsd, priorAccounting: {path: priorFile, sha256: sha256(readFileSync(priorFile))},
  sourceCohort: sourceDirectory, budgetPolicy: 'reported-usage-stop', overshootAccepted: true,
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), implementationFiles: implementationHashes(),
  lockfileSha256: sha256(readFileSync('pnpm-lock.yaml')), limits: {...LIMITS, sessions: 3, turnsPerSession: 2,
    controlThresholdUsd: 0.15, pressureThresholdUsd: 0.7}, credentialPresent: !!key});
evidence.write('sdk-audit.json', audit);
const summaries: unknown[] = []; const errors: unknown[] = [];
let inputAttempts = 0;
console.log(JSON.stringify({event: 'state-study-started', evidence: evidence.directory, carriedUsd, mode}));
try {
  if (mode === 'run') claimStateStage(sourceDirectory, evidence.directory);
  if (mode === 'run') for (const trial of trials) {
    const pressure = trial.block > 1; const reservation = pressure ? 0.7 : 0.15;
    if (carriedUsd + reservation > 2) throw new Error('STUDY_ADMISSION_CAP');
    const guard = new UsageGuard(model, 2, reservation, carriedUsd);
    const trialEvidence = new Evidence(join(evidence.directory, trial.id), [key]);
    const store = new StateStore(trialEvidence.directory);
    trialEvidence.write('state-info.json', {handle: store.handle, ...store.integrity()});
    evidence.record('session.reserved', {trial: trial.id, carriedUsd, reservation});
    console.log(JSON.stringify({event: 'state-session-started', trial: trial.id, reservation}));
    const makeClient = () => new OpenAI({apiKey: key, maxRetries: 0, timeout: LIMITS.deadlineMs, fetch: boundedFetch(fetch),
      ...(process.env.OPENAI_PROJECT_ID ? {project: process.env.OPENAI_PROJECT_ID} : {})});
    const setupLog = new Evidence(join(trialEvidence.directory, 'setup'), [key]);
    const setupLedger = new StateLedger(store, 'setup', setupLog);
    inputAttempts++;
    const setup = await collectTrial(makeClient(), trial, setupLog, guard, {request: stateRequest(trial), ledger: setupLedger});
    let lookup: Collected | null = null;
    if (setup.sessionId && setup.terminal === 'agent.session.turn.completed' && !setup.error && setupLedger.names.has('tracer_manifest')) {
      const first = randomInt(RECORD_COUNT); let second = randomInt(RECORD_COUNT - 1); if (second >= first) second++;
      const indices = [first, second];
      const query = stateQuery(indices, pressure);
      if (query.input.includes(store.handle)) throw new Error('HANDLE_REINTRODUCED');
      trialEvidence.write('query.json', {selectedAt: new Date().toISOString(), indices, ...query, stateSha256: store.sha256});
      trialEvidence.record('query.selected-after-setup', {indices, pressureBytes: query.pressureBytes, state: store.integrity()});
      guard.check(setup.sessionId);
      const lookupLog = new Evidence(join(trialEvidence.directory, 'lookup'), [key]);
      const lookupLedger = new StateLedger(store, 'lookup', lookupLog, indices);
      inputAttempts++;
      lookup = await collectTrial(makeClient(), {...trial, id: `${trial.id}-lookup`}, lookupLog, guard, {
        ledger: lookupLedger, continuation: {sessionId: setup.sessionId, input: query.input},
      });
    }
    const integrity = store.integrity();
    const summary = {trial: trial.id, pressure, setup, lookup, integrity,
      retrievalCorrect: lookup?.taskCorrect === true && integrity.actualSha256 === integrity.expectedSha256,
      compactionBoundary: 'unestablished', compactionSurvival: 'inconclusive', budget: guard.snapshot()};
    trialEvidence.write('collection.json', lookup ?? setup);
    trialEvidence.write('result.json', summary); summaries.push(summary);
    evidence.record('session.collected', summary);
    carriedUsd = guard.snapshot().admissionEstimateUsd;
    console.log(JSON.stringify({event: 'state-session-finished', trial: trial.id, retrievalCorrect: summary.retrievalCorrect,
      error: lookup?.error ?? setup.error, carriedUsd}));
    if (setup.error || lookup?.error) break;
  }
} catch (error) {errors.push({...safeError(error), reason: error instanceof Error ? error.message : 'UNKNOWN'});}
evidence.write('result.json', {protocol: STATE_PROTOCOL, mode, summaries, errors, inputAttempts,
  conservativeAdmissionEstimateUsd: carriedUsd, thresholdUsd: 2, overshootPossible: true, invoice: false,
  compactionSurvival: 'inconclusive', reason: 'Independent evidence of a managed compaction boundary is required.'});
console.log(JSON.stringify({evidence: evidence.directory, inputAttempts, conservativeAdmissionEstimateUsd: carriedUsd,
  errors, compactionSurvival: 'inconclusive'}, null, 2));
if (errors.length) process.exitCode = 2;
