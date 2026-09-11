// Read-only recovery for this study's own sessions; never resumes model work.
import OpenAI from 'openai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedFetch, UsageGuard } from './budget.js';
import { allPages, type Collected } from './collector.js';
import { Evidence, safeError, verifyLog } from './evidence.js';
import type { Trial } from './protocol.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: pnpm reconcile <study-directory>');
process.loadEnvFile('.env');
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('MISSING_OPENAI_API_KEY');
verifyLog(join(directory, 'events.jsonl'));
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {trials: Trial[]; modelRequested: string};
const evidence = new Evidence(join(directory, `reconcile-${new Date().toISOString().replace(/[:.]/g, '-')}`), [apiKey]);
const budget = new UsageGuard(manifest.modelRequested);
const client = new OpenAI({apiKey, maxRetries: 0, timeout: 10_000, fetch: boundedFetch(fetch),
  ...(process.env.OPENAI_PROJECT_ID ? {project: process.env.OPENAI_PROJECT_ID} : {})});
const summaries: unknown[] = [];
try {
  for (const trial of manifest.trials) {
    const collectionFile = join(directory, trial.id, 'collection.json');
    if (!existsSync(collectionFile)) continue;
    const collection = JSON.parse(readFileSync(collectionFile, 'utf8')) as Collected;
    if (!collection.sessionId) continue;
    const id = collection.sessionId;
    const session = await client.beta.agents.sessions.retrieve(id);
    if (session.metadata.trial !== trial.id) throw new Error('SESSION_OWNERSHIP_MISMATCH');
    evidence.record('session', session); budget.observeSession(id, session.usage);
    const turns = await allPages(client.beta.agents.sessions.turns.list(id, {limit: 100, order: 'asc'}), evidence, 'turns');
    for (const turn of turns) budget.observeTurn(id, turn);
    const items = await allPages(client.beta.agents.sessions.items.list(id, {limit: 100, order: 'asc'}), evidence, 'items');
    const children = await allPages(client.beta.agents.sessions.subagents.list(id, {limit: 100, order: 'asc'}), evidence, 'children');
    const childSummaries: unknown[] = [];
    for (const child of children) {
      const childTurns = await allPages(client.beta.agents.sessions.subagents.turns.list(child.id,
        {session_id: id, limit: 100, order: 'asc'}), evidence, `child.turns:${child.id}`);
      for (const turn of childTurns) budget.observeTurn(id, turn);
      await allPages(client.beta.agents.sessions.subagents.items.list(child.id,
        {session_id: id, limit: 100, order: 'asc'}), evidence, `child.items:${child.id}`);
      childSummaries.push({id: child.id, status: child.status, turns: childTurns.map(t => ({id: t.id, status: t.status, usage: t.usage}))});
    }
    summaries.push({trial: trial.id, sessionId: id, sessionStatus: session.status,
      pendingActions: session.required_actions.length, turns: turns.map(t => ({id: t.id, status: t.status, usage: t.usage})),
      itemCount: items.length, children: childSummaries});
  }
} catch (error) {evidence.record('error', safeError(error)); process.exitCode = 1;}
const result = {readOnly: true, summaries, budget: budget.snapshot()};
evidence.write('result.json', result);
console.log(JSON.stringify({evidence: evidence.directory, ...result}, null, 2));
