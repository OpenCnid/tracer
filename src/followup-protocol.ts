import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentSessionItem, Subagent } from 'openai/resources/beta/agents/agents';
import { fixture, requestFor, sha256, type Trial } from './protocol.js';
import { verifyLog } from './evidence.js';

export const FOLLOWUP_PROTOCOL = 'collect-all-v5';
export const STATE_PROTOCOL = 'external-state-v6';
export const FOLLOWUP_PREREGISTRATION = 'evidence/preregistration-v5.json';
export const PRESSURE_BYTES = 640 * 1024;

export function claimStateStage(sourceDirectory: string, runDirectory: string) {
  try {
    writeFileSync(join(sourceDirectory, 'state-stage-claim.json'), JSON.stringify({
      protocol: STATE_PROTOCOL, runDirectory: resolve(runDirectory), claimedAt: new Date().toISOString(),
      note: 'This Stage A allowance has admitted its one Stage B attempt. No automatic redispatch.',
    }, null, 2) + '\n', {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('STATE_STAGE_ALREADY_DISPATCHED');
    throw error;
  }
}

export function followupRegistration() {
  const frozen = JSON.parse(readFileSync(FOLLOWUP_PREREGISTRATION, 'utf8')) as {
    protocol: string; stateProtocol: string; sha256: string; documents: {path: string; sha256: string}[];
  };
  const documents = frozen.documents.map(d => ({path: d.path,
    sha256: sha256(readFileSync(d.path, 'utf8').replace(/\r\n/g, '\n'))}));
  if (frozen.protocol !== FOLLOWUP_PROTOCOL || frozen.stateProtocol !== STATE_PROTOCOL ||
      sha256(JSON.stringify(documents)) !== frozen.sha256) throw new Error('PREREGISTRATION_CHANGED');
  return {protocolHash: frozen.sha256, protocolDocuments: documents};
}

export const implementationHashes = () => readdirSync('src').filter(f => f.endsWith('.ts')).map(f => ({
  path: `src/${f}`, sha256: sha256(readFileSync(join('src', f))),
}));

export function joinMatrix(seed: string, model: string): Trial[] {
  return [1, 2, 3].flatMap(block => {
    const arms: Trial['arm'][] = block % 2 ? ['direct-native', 'programmatic-native'] : ['programmatic-native', 'direct-native'];
    return arms.map(arm => ({id: `b${block}-${arm}`, block, arm, model, seed: sha256(`${seed}:${block}:${arm}`)}));
  });
}

export function joinRequest(trial: Trial) {
  const request = requestFor(trial);
  request.metadata = {protocol: FOLLOWUP_PROTOCOL, trial: trial.id};
  request.input += '\n\nCollection contract: Keep a mapping of task key to created child ID and a set of pending IDs. A wait may return only a subset. Examine the actual returned structure: save each completed final answer under its child ID and remove only that completed child from pending. Continue waiting for the remaining IDs until BOTH final answer strings exist. Allow at most six waits per child. A successful wait action is not proof all children finished. Do not stringify undefined, guess absent fields, rerun children, or compute answers in the parent. Submit once only after both values are real final answer strings; otherwise stop and report the actual return shape/error. In the programmatic arm, keep this entire collection loop inside generated code, using actual runtime signatures.';
  if (trial.arm === 'programmatic-native') request.input += '\nAfter execution, include the exact JavaScript you submitted to exec in a fenced code block labeled REPORTED SOURCE. We will retain it as your report; it is not independent proof of execution. Do not rerun a program just to report it.';
  return request;
}

export function collectionAgreement(directory: string, trial: Trial) {
  const log = join(directory, 'events.jsonl');
  const verifiedRecords = verifyLog(log);
  const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as {
    sequence: number; kind: string; data: any;
  });
  const children: Subagent[] = rows.filter(r => r.kind === 'children').flatMap(r => r.data.data);
  const submission = rows.find(r => r.kind === 'function.executed' && r.data.action.name === 'tracer_submit');
  const submitted: {key: string; value: string}[] = submission?.data.action.arguments?.results ?? [];
  const tasks = fixture(trial).tasks;
  const results = tasks.map(task => {
    const matchingChildren = children.filter(c => c.instructions?.some(p => p.type === 'output_text' && p.text.includes(task.nonce)));
    if (matchingChildren.length !== 1) return {key: task.key, agreement: false, reason: 'CHILD_MAPPING_UNESTABLISHED'};
    const child = matchingChildren[0]!;
    const items: AgentSessionItem[] = rows.filter(r => r.kind === `child.items:${child.id}`).flatMap(r => r.data.data);
    const final = items.filter(i => i.type === 'message' && i.role === 'assistant' && i.phase === 'final_answer').at(-1);
    const text = final?.type === 'message' ? final.content.filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim() : null;
    const turns = rows.filter(r => r.kind === `child.turns:${child.id}`).flatMap(r => r.data.data);
    const actual = submitted.filter(s => s.key === task.key);
    return {key: task.key, childId: child.id, finalText: text,
      childTaskCorrect: text === [...task.nonce].reverse().join(''),
      submittedValue: actual[0]?.value ?? null,
      agreement: turns.length === 1 && turns[0]?.status === 'completed' && text !== null && actual.length === 1 && actual[0]!.value === text};
  });
  return {verifiedRecords, logSha256: sha256(readFileSync(log)),
    completeAgreement: submitted.length === 2 && results.every(r => r.agreement), results,
    route: 'unestablished', note: 'Content agreement does not establish the executing program or its caller edges.'};
}
