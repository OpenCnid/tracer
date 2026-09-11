// Descriptive evidence extraction only. This does not certify the PTC route.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionItem, Subagent } from 'openai/resources/beta/agents/agents';
import { fixture, sha256, type Trial } from './protocol.js';
import { verifyLog } from './evidence.js';
import type { Collected } from './collector.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: pnpm analyze <study-directory>');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {trials: Trial[]; protocol: string};
type Row = {sequence: number; at: string; kind: string; hash: string; data: Record<string, unknown>};
const trials = manifest.trials.map(trial => {
  const logPath = join(directory, trial.id, 'events.jsonl');
  const collectionPath = join(directory, trial.id, 'collection.json');
  if (!existsSync(collectionPath)) return {trial: trial.id, arm: trial.arm, started: false};
  const collection = JSON.parse(readFileSync(collectionPath, 'utf8')) as Collected;
  const verifiedRecords = verifyLog(logPath);
  const rows = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
  const items = (kind: string) => rows.filter(r => r.kind === kind).flatMap(r => r.data.data as AgentSessionItem[]);
  const children = rows.filter(r => r.kind === 'children').flatMap(r => r.data.data as Subagent[]);
  const expected = fixture(trial).tasks.map(task => ({key: task.key, nonce: task.nonce, value: [...task.nonce].reverse().join('')}));
  const submission = rows.find(r => r.kind === 'function.executed' && (r.data.action as {name?: string}).name === 'tracer_submit');
  const waits = rows.filter(r => r.kind === 'sse' && (r.data.item as {type?: string} | undefined)?.type === 'wait_for_subagents_call')
    .map(r => ({sequence: r.sequence, at: r.at, eventType: r.data.type, item: r.data.item}));
  const childResults = children.map(child => {
    const history = items(`child.items:${child.id}`);
    const prompt = child.instructions?.filter(p => p.type === 'output_text').map(p => p.text).join('\n') ?? '';
    const task = expected.find(t => prompt.includes(t.nonce));
    const answer = history.filter(i => i.type === 'message' && i.role === 'assistant' && i.phase === 'final_answer').at(-1);
    const text = answer?.type === 'message' ? answer.content.filter(p => p.type === 'output_text').map(p => p.text).join('\n') : null;
    return {childId: child.id, taskKey: task?.key ?? null, finalText: text,
      trimmedExact: task && text !== null ? text.trim() === task.value : null};
  });
  return {trial: trial.id, arm: trial.arm, block: trial.block, started: true, ...collection,
    source: {logPath: logPath.replaceAll('\\', '/'), sha256: sha256(readFileSync(logPath)), verifiedRecords},
    expected, submission: submission ? {sequence: submission.sequence, at: submission.at, action: submission.data.action} : null,
    waits, childResults};
});
const result = {protocol: manifest.protocol, sourceSha256: sha256(readFileSync('src/analyze.ts')),
  routeCertified: false, note: 'Derived observations. Child correctness and wait records do not prove program-to-child caller edges.', trials};
const output = join(directory, 'analysis.json');
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({analysis: output, trials: trials.map(t => ({trial: t.trial, started: t.started,
  taskCorrect: 'taskCorrect' in t ? t.taskCorrect : null}))}, null, 2));
