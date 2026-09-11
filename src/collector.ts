// Transport implementation with explicit cancellation and reported-usage guards.
import type OpenAI from 'openai';
import type { AgentSessionEvent, AgentSession } from 'openai/resources/beta/agents/agents';
import type { SessionCreateParamsStreaming } from 'openai/resources/beta/agents/sessions/sessions';
import { AdmissionCounter, type UsageGuard } from './budget.js';
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

export interface CollectionOptions {
  request?: SessionCreateParamsStreaming;
  ledger?: Pick<FunctionLedger, 'handle' | 'correct'>;
  continuation?: {sessionId: string; input: string};
  onSession?: (sessionId: string) => void;
}

export async function collectTrial(client: OpenAI, trial: Trial, evidence: Evidence, budget?: UsageGuard,
  options: CollectionOptions = {}): Promise<Collected> {
  const result: Collected = { sessionId: null, terminal: null, taskCorrect: null,
    completedChildren: 0, historyComplete: false, route: 'unestablished', error: null };
  const ledger = options.ledger ?? new FunctionLedger(trial, evidence);
  const request = options.request ?? requestFor(trial);
  evidence.write('request.json', options.continuation ?? request);
  const abort = new AbortController();
  let stopped: Error | undefined;
  const stop = (error: Error) => { stopped ??= error; abort.abort(error); };
  const deadline = setTimeout(() => stop(new Error('TRIAL_DEADLINE')), LIMITS.deadlineMs);
  let polling: Promise<void> | undefined; let finalizing = false;
  const poll = budget ? setInterval(() => {
    if (!result.sessionId || polling || abort.signal.aborted) return;
    const id = result.sessionId;
    polling = (async () => {
      const current = await client.beta.agents.sessions.retrieve(id, { signal: abort.signal });
      evidence.record('budget.session', current);
      budget.observeModel(current.agent.model); budget.observeSession(id, current.usage);
      const turns = await allPages(client.beta.agents.sessions.turns.list(id, {limit: 100, order: 'asc'},
        {signal: abort.signal}), evidence, 'budget.turns');
      for (const turn of turns) budget.observeTurn(id, turn);
      evidence.record('budget.snapshot', budget.snapshot()); budget.check(id);
    })().catch(error => { if (!finalizing) stop(error instanceof Error ? error : new Error('BUDGET_TELEMETRY_FAILED')); })
      .finally(() => { polling = undefined; });
  }, 10_000) : undefined;
  const seen = new Set<string>(); const childrenSeen = new Set<string>(); let eventCount = 0;
  let boundSession: string | null = null;
  let stream: (AsyncIterable<AgentSessionEvent> & {controller: AbortController}) | undefined;
  try {
    if (options.continuation) {
      result.sessionId = options.continuation.sessionId;
      stream = client.beta.agents.sessions.stream(result.sessionId, {
        input: options.continuation.input, idempotencyKey: trial.id,
      }, {signal: abort.signal});
      evidence.record('http.continuation-planned', {sessionId: result.sessionId, idempotencyKey: trial.id});
    } else {
      const created = await client.beta.agents.sessions.create(request, { signal: abort.signal }).withResponse();
      stream = created.data;
      evidence.record('http.create', { status: created.response.status, request_id: created.request_id });
    }
    for await (const event of stream) {
      if ('session_id' in event) result.sessionId = event.session_id;
      if (event.type === 'agent.session.created') result.sessionId = event.session.id;
      evidence.record('sse', event);
      if (result.sessionId && options.onSession) {
        if (boundSession && boundSession !== result.sessionId) throw new Error('SESSION_ID_CHANGED');
        if (!boundSession) { options.onSession(result.sessionId); boundSession = result.sessionId; }
      }
      if (budget && result.sessionId) {
        if ('session' in event) { budget.observeSession(result.sessionId, event.session.usage); budget.observeModel(event.session.agent.model); }
        if ('turn' in event) budget.observeTurn(result.sessionId, event.turn, 'usage' in event ? event.usage : undefined);
        if ('item' in event && event.item.type === 'create_subagent_call') budget.observeModel(event.item.model);
        budget.check(result.sessionId);
      }
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
        if (budget) { budget.observeSession(result.sessionId, current.usage); budget.check(result.sessionId); }
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
    if (poll) clearInterval(poll);
    await polling; if (stopped) throw stopped;
    if (result.sessionId) {
      const id = result.sessionId;
      const opts = { signal: abort.signal };
      const items = await allPages(client.beta.agents.sessions.items.list(id, { limit: 100, order: 'asc' }, opts), evidence, 'root.items');
      for (const item of items) if (item.type === 'create_subagent_call') budget?.observeModel(item.model);
      const turns = await allPages(client.beta.agents.sessions.turns.list(id, { limit: 100, order: 'asc' }, opts), evidence, 'session.turns');
      for (const turn of turns) budget?.observeTurn(id, turn);
      const children = await allPages(client.beta.agents.sessions.subagents.list(id, { limit: 100, order: 'asc' }, opts), evidence, 'children');
      if (children.length > 2) throw new Error('EXCESS_CHILDREN_OBSERVED');
      for (const child of children) {
        await allPages(client.beta.agents.sessions.subagents.items.list(child.id,
          { session_id: id, limit: 100, order: 'asc' }, opts), evidence, `child.items:${child.id}`);
        const childTurns = await allPages(client.beta.agents.sessions.subagents.turns.list(child.id,
          { session_id: id, limit: 100, order: 'asc' }, opts), evidence, `child.turns:${child.id}`);
        for (const turn of childTurns) budget?.observeTurn(id, turn);
        if (childTurns.length === 1 && childTurns[0]?.status === 'completed') result.completedChildren++;
      }
      evidence.record('usage.snapshot', turns.map(turn => ({ id: turn.id, subagent_id: turn.subagent_id, usage: turn.usage })));
      const current = await client.beta.agents.sessions.retrieve(id, opts);
      evidence.record('session.snapshot', current);
      budget?.observeSession(id, current.usage);
      result.historyComplete = true;
      budget?.check(id);
    }
  } catch (error) {
    error = stopped ?? error;
    result.error = { ...safeError(error), localReason: error instanceof Error &&
      /^[A-Z_]+(?::[a-z.]+)?$/.test(error.message) ? error.message : null };
    evidence.tryRecord('collector.error', result.error);
    evidence.tryRecord('collector.diagnostic',error instanceof Error?{message:error.message.slice(0,512),stack:error.stack?.split('\n').slice(0,6).join('\n').slice(0,2048)??null}:{type:typeof error});
  } finally {
    finalizing = true; clearTimeout(deadline); if (poll) clearInterval(poll);
    abort.abort(); stream?.controller.abort(); await polling;
    result.taskCorrect = ledger.correct;
    // Closing SSE does not stop managed work. Explicitly send cancellation.
    // This is cleanup, never a hard billing guarantee or proof all descendants stopped.
    if (result.sessionId && (result.error !== null || result.terminal !== 'agent.session.turn.completed' ||
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
    if (budget) evidence.write('budget.json', budget.snapshot());
    evidence.write('collection.json', result);
  }
  return result;
}

export function isRootTerminal(event: AgentSessionEvent): boolean {
  return (event.type === 'agent.session.turn.completed' || event.type === 'agent.session.turn.failed' ||
    event.type === 'agent.session.turn.cancelled') && event.turn.subagent_id === null;
}
