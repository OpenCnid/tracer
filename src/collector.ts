// Transport implementation. The CLI's paid gate remains closed on this SDK.
// Tests exercise this collector with the official SDK and a mock HTTP transport.
import type OpenAI from 'openai';
import type { AgentSessionEvent, AgentSession } from 'openai/resources/beta/agents/agents';
import { AdmissionCounter } from './budget.js';
import { Evidence, safeError } from './evidence.js';
import { checkResults, fixture, LIMITS, requestFor, type Trial } from './protocol.js';

interface Page<T> { data: T[]; hasNextPage(): boolean; getNextPage(): Promise<Page<T>> }
export async function allPages<T>(first: PromiseLike<Page<T>>, evidence: Evidence, kind: string): Promise<T[]> {
  const result: T[] = []; let page = await first;
  for (let i = 0; i < LIMITS.pages; i++) {
    evidence.record(kind, { page: i, data: page.data }); result.push(...page.data);
    if (!page.hasNextPage()) return result;
    if (i + 1 === LIMITS.pages) throw new Error('PAGE_CAP');
    page = await page.getNextPage();
  }
  throw new Error('PAGE_CAP');
}

export class FunctionLedger {
  private readonly saved = new Map<string, { args: string; output: string }>();
  private readonly names = new Set<string>();
  private readonly counter = new AdmissionCounter();
  correct: boolean | null = null;
  constructor(private readonly trial: Trial, private readonly evidence: Evidence) {}
  handle(sessionId: string, action: Extract<AgentSession['required_actions'][number], {type: 'function_call'}>) {
    const key = `${sessionId}:${action.turn_id}:${action.call_id}`;
    const args = JSON.stringify({ name: action.name, arguments: action.arguments });
    const saved = this.saved.get(key);
    if (saved) {
      if (saved.args !== args) throw new Error('CHANGED_DUPLICATE_CALL');
      this.evidence.record('function.reused', { key });
      return saved.output;
    }
    if (this.names.has(action.name)) throw new Error('REPEATED_LOGICAL_TOOL');
    let value: unknown;
    if (action.name === 'tracer_fixture') {
      if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments) ||
          Object.keys(action.arguments).length !== 0) throw new Error('INVALID_FIXTURE_ARGUMENTS');
      value = fixture(this.trial);
    } else if (action.name === 'tracer_submit') {
      if (!this.names.has('tracer_fixture')) throw new Error('SUBMIT_BEFORE_FIXTURE');
      this.correct = checkResults(this.trial, action.arguments);
      value = { accepted: this.correct };
    } else throw new Error('UNEXPECTED_TOOL');
    const output = JSON.stringify(value); this.counter.admit(output);
    this.evidence.record('function.executed', { key, action, output }); // persisted before transmission
    this.saved.set(key, { args, output }); this.names.add(action.name);
    return output;
  }
}

export interface Collected {
  sessionId: string | null; terminal: string | null; taskCorrect: boolean | null;
  completedChildren: number; historyComplete: boolean; route: 'unestablished'; error: unknown;
}

export async function collectTrial(client: OpenAI, trial: Trial, evidence: Evidence): Promise<Collected> {
  const result: Collected = { sessionId: null, terminal: null, taskCorrect: null,
    completedChildren: 0, historyComplete: false, route: 'unestablished', error: null };
  const ledger = new FunctionLedger(trial, evidence);
  const request = requestFor(trial); evidence.write('request.json', request);
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error('TRIAL_DEADLINE')), LIMITS.deadlineMs);
  const seen = new Set<string>(); const childrenSeen = new Set<string>(); let eventCount = 0;
  let stream: Awaited<ReturnType<typeof client.beta.agents.sessions.events.stream>> | undefined;
  try {
    const created = await client.beta.agents.sessions.create(request, { signal: abort.signal }).withResponse();
    stream = created.data;
    evidence.record('http.create', { status: created.response.status, request_id: created.request_id });
    for await (const event of stream) {
      if ('session_id' in event) result.sessionId = event.session_id;
      if (event.type === 'agent.session.created') result.sessionId = event.session.id;
      evidence.record('sse', event);
      if (++eventCount > LIMITS.events) throw new Error('EVENT_CAP');
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      if (event.type === 'agent.session.subagent.created') {
        childrenSeen.add(event.subagent.id);
        if (childrenSeen.size > 2) throw new Error('EXCESS_CHILDREN_OBSERVED');
      }
      if (event.type === 'agent.session.requires_action') {
        if (!result.sessionId) throw new Error('MISSING_SESSION_ID');
        // Pending actions, not historical function-call items, authorize execution.
        const current = await client.beta.agents.sessions.retrieve(result.sessionId, { signal: abort.signal });
        evidence.record('required-actions.snapshot', current);
        for (const action of current.required_actions) {
          if (action.type !== 'function_call') throw new Error('UNEXPECTED_ENVIRONMENT_ACTION');
          const output = ledger.handle(result.sessionId, action);
          await client.beta.agents.sessions.events.create(result.sessionId, {
            'Idempotency-Key': `${trial.id}-${action.call_id}`,
            events: [{ type: 'agent.session.input.tool_result', call_id: action.call_id,
              turn_id: action.turn_id, success: true, output }],
          }, { signal: abort.signal });
          evidence.record('function.transmitted', { call_id: action.call_id });
        }
      }
      if (isRootTerminal(event)) { result.terminal = event.type; break; }
      if (['error', 'agent.session.failed', 'agent.session.environment.failed'].includes(event.type))
        throw new Error(`LIFECYCLE_FAILURE:${event.type}`);
    }
    if (!result.terminal) throw new Error('STREAM_ENDED_WITHOUT_ROOT_TERMINAL');
    if (result.sessionId) {
      const id = result.sessionId;
      const opts = { signal: abort.signal };
      await allPages(client.beta.agents.sessions.items.list(id, { limit: 100, order: 'asc' }, opts), evidence, 'root.items');
      const turns = await allPages(client.beta.agents.sessions.turns.list(id, { limit: 100, order: 'asc' }, opts), evidence, 'session.turns');
      const children = await allPages(client.beta.agents.sessions.subagents.list(id, { limit: 100, order: 'asc' }, opts), evidence, 'children');
      if (children.length > 2) throw new Error('EXCESS_CHILDREN_OBSERVED');
      for (const child of children) {
        await allPages(client.beta.agents.sessions.subagents.items.list(child.id,
          { session_id: id, limit: 100, order: 'asc' }, opts), evidence, `child.items:${child.id}`);
        const childTurns = await allPages(client.beta.agents.sessions.subagents.turns.list(child.id,
          { session_id: id, limit: 100, order: 'asc' }, opts), evidence, `child.turns:${child.id}`);
        if (childTurns.length === 1 && childTurns[0]?.status === 'completed') result.completedChildren++;
      }
      evidence.record('usage.snapshot', turns.map(turn => ({ id: turn.id, subagent_id: turn.subagent_id, usage: turn.usage })));
      evidence.record('session.snapshot', await client.beta.agents.sessions.retrieve(id, opts));
      result.historyComplete = true;
    }
  } catch (error) {
    result.error = { ...safeError(error), localReason: error instanceof Error &&
      /^[A-Z_]+(?::[a-z.]+)?$/.test(error.message) ? error.message : null };
    evidence.tryRecord('collector.error', result.error);
  } finally {
    clearTimeout(deadline); stream?.controller.abort();
    result.taskCorrect = ledger.correct;
    // Closing SSE does not stop managed work. Explicitly send cancellation.
    // This is cleanup, never a hard billing guarantee or proof all descendants stopped.
    if (result.sessionId && (result.terminal !== 'agent.session.turn.completed' ||
        (trial.arm !== 'programmatic-local' && result.completedChildren !== 2))) {
      try {
        await client.beta.agents.sessions.events.create(result.sessionId,
          { events: [{ type: 'agent.session.input.cancel' }] }, { timeout: 10_000 });
        evidence.tryRecord('cleanup.cancel-accepted', { sessionId: result.sessionId });
        evidence.tryRecord('cleanup.session', await client.beta.agents.sessions.retrieve(result.sessionId, { timeout: 10_000 }));
      } catch (error) { evidence.tryRecord('cleanup.unresolved', safeError(error)); }
    }
    evidence.tryRecord('cleanup.retention', { retainedForTraceReview: !!result.sessionId,
      environment: 'none', serverDescendantTerminationGuaranteed: false });
    evidence.write('collection.json', result);
  }
  return result;
}

export function isRootTerminal(event: AgentSessionEvent): boolean {
  return (event.type === 'agent.session.turn.completed' || event.type === 'agent.session.turn.failed' ||
    event.type === 'agent.session.turn.cancelled') && event.turn.subagent_id === null;
}
