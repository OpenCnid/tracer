import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { authorizePaidInference, boundedFetch, HardCapUnavailable } from './budget.js';
import { Evidence, safeError } from './evidence.js';
import { LIMITS, matrix, PROTOCOL, requestFor, SDK_VERSION, sha256 } from './protocol.js';
import { auditSdk } from './sdk-audit.js';
import { collectTrial } from './collector.js';

const args = process.argv.slice(2);
const mode = args[0] ?? 'plan';
if (!['plan', 'preflight', 'run'].includes(mode) || args.slice(1).some(a => a !== '--online') ||
    (args.includes('--online') && mode !== 'preflight')) {
  throw new Error('Usage: pnpm probe [plan|preflight [--online]|run]. No paid-budget override exists.');
}
if (existsSync('.env')) process.loadEnvFile('.env');
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
const model = process.env.TRACER_MODEL?.trim() || 'gpt-6-astra';
const seed = randomUUID();
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-${seed.slice(0, 8)}`;
const directory = join('evidence', 'runs', runId);
const evidence = new Evidence(directory, [apiKey]);
const protocolText = readFileSync('research/02-preregistered-probe.md', 'utf8').replace(/\r\n/g, '\n');
const frozen = JSON.parse(readFileSync('evidence/preregistration.json', 'utf8')) as {sha256: string};
const protocolHash = sha256(protocolText);
const audit = auditSdk();
const trials = matrix(seed, model);
evidence.write('manifest.json', {
  protocol: PROTOCOL, protocolHash, seed, runId, mode, createdAt: new Date().toISOString(),
  sdk: SDK_VERSION, node: process.version, pnpmUserAgent: process.env.npm_config_user_agent ?? null,
  os: process.platform, modelRequested: model, serviceTier: 'default', serverVersion: null,
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0,
  implementationFiles: readdirSync('src').filter(f => f.endsWith('.ts')).map(f => ({
    path: `src/${f}`, sha256: sha256(readFileSync(join('src', f))),
  })),
  lockfileSha256: sha256(readFileSync('pnpm-lock.yaml')), limits: LIMITS,
  credentialPresent: !!apiKey, projectBindingPresent: !!process.env.OPENAI_PROJECT_ID,
  sourceManifestSha256: existsSync('research/sources.json') ? sha256(readFileSync('research/sources.json')) : null,
  trials,
});
evidence.write('sdk-audit.json', audit);
evidence.write('requests.json', trials.map(trial => ({ trial: trial.id, request: requestFor(trial) })));
const reasons: string[] = [];
if (protocolHash !== frozen.sha256) reasons.push('PREREGISTRATION_CHANGED');
if (!audit.versionMatches) reasons.push('SDK_VERSION_CHANGED');
if (!apiKey) reasons.push('MISSING_OPENAI_API_KEY');
try { authorizePaidInference(); } catch (e) {
  if (!(e instanceof HardCapUnavailable)) throw e;
  reasons.push(e.code); evidence.record('gate.hard-cap', { code: e.code, message: e.message });
}

let readOnlyRequests = 0;
if (mode === 'preflight' && args.includes('--online') && apiKey && audit.versionMatches && protocolHash === frozen.sha256) {
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 10_000,
    ...(process.env.OPENAI_PROJECT_ID ? { project: process.env.OPENAI_PROJECT_ID } : {}),
    fetch: boundedFetch(fetch) });
  try {
    readOnlyRequests++;
    const { response, request_id, data } = await client.beta.agents.sessions.list({ limit: 1 }).withResponse();
    evidence.record('preflight.read-only-http', { status: response.status, request_id, returnedCount: data.data.length });
    // Existing session data are neither stored nor republished.
  } catch (e) { reasons.push('READ_ONLY_ACCESS_FAILED'); evidence.record('preflight.error', safeError(e)); }
}
let paidInferenceRequests = 0; let sessionsCreated = 0; let completedTrials = 0; let reservedUsd = 0;
if (mode === 'run' && reasons.length === 0) {
  // Unreachable with the current cap authority. Retain the real collector path
  // so replacing the authority in a new protocol does not require another runner.
  for (const trial of trials) {
    if (paidInferenceRequests >= LIMITS.sessions || reservedUsd + LIMITS.reservationUsd > LIMITS.studyUsd)
      throw new Error('STUDY_ADMISSION_CAP');
    reservedUsd += LIMITS.reservationUsd; paidInferenceRequests++;
    evidence.record('trial.reserved', { trial: trial.id, reservedUsd });
    // Each trial gets the same HTTP allowance, including its cleanup reserve.
    // At most nine trials therefore admit at most 9 * 40 HTTP requests.
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: LIMITS.deadlineMs,
      ...(process.env.OPENAI_PROJECT_ID ? { project: process.env.OPENAI_PROJECT_ID } : {}), fetch: boundedFetch(fetch) });
    const collection = await collectTrial(client, trial, new Evidence(join(directory, trial.id), [apiKey]));
    if (collection.sessionId) sessionsCreated++;
    if (collection.terminal === 'agent.session.turn.completed') completedTrials++;
    if (collection.error) { reasons.push('COLLECTION_INTERRUPTED'); break; }
  }
} else if (mode === 'run') {
  for (const trial of trials) evidence.record('trial.not-started', { trial: trial.id, reasons });
}
const result = { outcome: 'inconclusive', scope: 'native programmatic delegation',
  mode, reasons, plannedTrials: 9, sessionsCreated, completedTrials,
  paidInferenceRequests, reservedUsd, readOnlyRequests, observedModelUsage: null,
  route: 'unestablished', note: 'Preflight and local tests are not real managed-agent experimental runs.' };
evidence.write('result.json', result);
console.log(JSON.stringify({ evidence: directory, ...result }, null, 2));
if (mode !== 'plan') process.exitCode = 2;
