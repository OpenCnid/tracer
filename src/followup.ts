import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { authorizePaidInference, boundedFetch, UsageGuard } from './budget.js';
import { collectTrial } from './collector.js';
import { Evidence, safeError } from './evidence.js';
import { DEFAULT_MODEL, LIMITS, SDK_VERSION, sha256 } from './protocol.js';
import { auditSdk } from './sdk-audit.js';
import { collectionAgreement, FOLLOWUP_PROTOCOL, followupRegistration, implementationHashes, joinMatrix, joinRequest } from './followup-protocol.js';

const mode = process.argv[2] ?? 'plan';
if (!['plan', 'run'].includes(mode) || process.argv.length > 3) throw new Error('Usage: pnpm followup [plan|run]');
if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.OPENAI_API_KEY?.trim() ?? '';
const model = process.env.TRACER_MODEL?.trim() || DEFAULT_MODEL;
const registration = followupRegistration(); const audit = auditSdk();
if (!audit.versionMatches || model !== DEFAULT_MODEL) throw new Error('SDK_OR_MODEL_CHANGED');
if (mode === 'run' && !key) throw new Error('MISSING_OPENAI_API_KEY');
authorizePaidInference('reported-usage-stop');
const seed = randomUUID(); const trials = joinMatrix(seed, model);
const evidence = new Evidence(join('evidence/runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${FOLLOWUP_PROTOCOL}-${mode}-${seed.slice(0,8)}`), [key]);
evidence.write('manifest.json', {protocol: FOLLOWUP_PROTOCOL, ...registration, mode, seed, trials,
  sdk: SDK_VERSION, node: process.version, pnpmUserAgent: process.env.npm_config_user_agent ?? null,
  modelRequested: model, priorEstimateUsd: 0, budgetPolicy: 'reported-usage-stop', overshootAccepted: true,
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  implementationFiles: implementationHashes(), lockfileSha256: sha256(readFileSync('pnpm-lock.yaml')),
  limits: {...LIMITS, sessions: 6}, credentialPresent: !!key});
evidence.write('sdk-audit.json', audit); evidence.write('requests.json', trials.map(t => ({trial: t.id, request: joinRequest(t)})));
const guard = new UsageGuard(model); let paidInferenceRequests = 0;
const summaries: any[] = []; const errors: unknown[] = [];
console.log(JSON.stringify({event: 'followup-started', evidence: evidence.directory, mode, thresholdUsd: 2}));
try {
  if (mode === 'run') for (const trial of trials) {
    if (paidInferenceRequests >= 6 || guard.snapshot().admissionEstimateUsd + 0.2 > 2) throw new Error('STUDY_ADMISSION_CAP');
    paidInferenceRequests++;
    evidence.record('trial.reserved', {trial: trial.id, reservationUsd: 0.2});
    console.log(JSON.stringify({event: 'trial-started', trial: trial.id}));
    const client = new OpenAI({apiKey: key, maxRetries: 0, timeout: LIMITS.deadlineMs, fetch: boundedFetch(fetch),
      ...(process.env.OPENAI_PROJECT_ID ? {project: process.env.OPENAI_PROJECT_ID} : {})});
    const trialEvidence = new Evidence(join(evidence.directory, trial.id), [key]);
    const collection = await collectTrial(client, trial, trialEvidence, guard, {request: joinRequest(trial)});
    const agreement = collectionAgreement(trialEvidence.directory, trial);
    trialEvidence.write('agreement.json', agreement);
    const summary = {trial: trial.id, arm: trial.arm, ...collection, agreement}; summaries.push(summary);
    evidence.record('trial.collected', {summary, budget: guard.snapshot()});
    console.log(JSON.stringify({event: 'trial-finished', trial: trial.id, taskCorrect: collection.taskCorrect,
      completeAgreement: agreement.completeAgreement, error: collection.error, estimateUsd: guard.snapshot().estimateUsd}));
    if (collection.error) break;
  }
} catch (error) {errors.push({...safeError(error), reason: error instanceof Error ? error.message : 'UNKNOWN'});}
const nativeAgreement = summaries.filter(s => s.arm === 'programmatic-native' && s.agreement.completeAgreement).length;
const result = {protocol: FOLLOWUP_PROTOCOL, mode, paidInferenceRequests, summaries, errors,
  nativeAgreement, stateGate: summaries.filter(s => s.arm === 'programmatic-native').length === 3 && nativeAgreement >= 2,
  budget: guard.snapshot(), route: 'unestablished', compactionSurvival: 'not-tested',
  note: 'Stage B shares this USD 2 allowance and must carry reconciled conservative admission estimates.'};
evidence.write('result.json', result);
console.log(JSON.stringify({evidence: evidence.directory, nativeAgreement, stateGate: result.stateGate,
  paidInferenceRequests, budget: guard.snapshot(), errors}, null, 2));
if (errors.length || summaries.some(s => s.error) || (mode === 'run' && !result.stateGate)) process.exitCode = 2;
