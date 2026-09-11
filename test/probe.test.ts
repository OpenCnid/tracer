import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionCounter, authorizePaidInference, boundedFetch, UsageGuard } from '../src/budget.js';
import { allPages, collectTrial, FunctionLedger } from '../src/collector.js';
import { decide, type TrialEvidence } from '../src/decision.js';
import { Evidence, verifyLog } from '../src/evidence.js';
import { DEFAULT_MODEL, fixture, LIMITS, matrix, PREREGISTRATION, PROTOCOL, requestFor, sha256 } from '../src/protocol.js';
import { auditSdk } from '../src/sdk-audit.js';

const dirs: string[] = [];
function evidence() {
  const dir = mkdtempSync(join(tmpdir(), 'tracer-test-')); dirs.push(dir);
  return new Evidence(dir, ['fake-test-secret']);
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
const trial = matrix('test-only-seed', 'test-model')[0]!;
const answers = (t = trial) => ({ results: fixture(t).tasks.map(task => ({ key: task.key, value: [...task.nonce].reverse().join('') })) });

describe('protocol and budget', () => {
  it('binds the USD 2 Luna cohort to its frozen documents and prior accounting', () => {
    const frozen = JSON.parse(readFileSync(PREREGISTRATION, 'utf8')) as {
      protocol: string; sha256: string; documents: Array<{path: string; sha256: string}>;
    };
    expect(frozen.protocol).toBe(PROTOCOL);
    expect(DEFAULT_MODEL).toBe('gpt-5.6-luna');
    expect(LIMITS.studyUsd).toBe(2);
    expect(LIMITS.reservationUsd * LIMITS.sessions).toBeLessThanOrEqual(LIMITS.studyUsd);
    const documents = frozen.documents.map(doc => ({path: doc.path,
      sha256: sha256(readFileSync(doc.path, 'utf8').replace(/\r\n/g, '\n'))}));
    expect(documents).toEqual(frozen.documents);
    expect(sha256(JSON.stringify(documents))).toBe(frozen.sha256);
  });
  it('has nine fresh seeds, rotating arm order, and no nonce in any request', () => {
    const trials = matrix('fixed-seed', 'test-model');
    expect(new Set(trials.map(t => t.seed)).size).toBe(9);
    expect(trials.filter(t => t.arm === 'programmatic-native').map(t => t.block)).toEqual([1, 2, 3]);
    for (const t of trials) for (const task of fixture(t).tasks)
      expect(JSON.stringify(requestFor(t))).not.toContain(task.nonce);
  });
  it('refuses inference even when a credential could exist', () => {
    const dispatch = vi.fn();
    expect(() => { authorizePaidInference(); dispatch(); }).toThrow('Paid inference refused');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('admits the explicitly approved reported-usage policy without claiming a hard cap', () => {
    expect(() => authorizePaidInference('reported-usage-stop')).not.toThrow();
    expect(new UsageGuard(DEFAULT_MODEL).snapshot()).toMatchObject({overshootPossible: true, invoice: false, estimateUsd: null});
  });
  it('rejects excess output before incrementing admissions', () => {
    const cap = new AdmissionCounter();
    expect(() => cap.admit('x'.repeat(LIMITS.toolOutputBytes + 1))).toThrow('BYTE_CAP');
    cap.admit('{}'); cap.admit('{}');
    expect(() => cap.admit('{}')).toThrow('EXECUTION_CAP');
  });
  it('caps HTTP requests while reserving cancellation capacity', async () => {
    const base = vi.fn(async () => new Response('{}'));
    const fetcher = boundedFetch(base);
    for (let i = 0; i < LIMITS.httpRequests - 4; i++) await fetcher('https://api.openai.com/v1/agents/sessions');
    await expect(fetcher('https://api.openai.com/v1/agents/sessions')).rejects.toThrow('HTTP_REQUEST_CAP');
    await fetcher('https://api.openai.com/v1/agents/sessions/session/events', {
      method: 'POST', body: '{"events":[{"type":"agent.session.input.cancel"}]}',
    });
    expect(base).toHaveBeenCalledTimes(LIMITS.httpRequests - 3);
  });
  it('inventories the pinned real SDK without claiming the error enum is a configurable cap', () => {
    const audit = auditSdk();
    expect(audit.versionMatches).toBe(true);
    expect(audit.sessionBudgetErrorPresent).toBe(true);
    expect(audit.properties.SessionCreateParamsBase).toContain('environment');
    expect(audit.properties.Agent).not.toContain('max_output_tokens');
    expect(audit.maximumEnforceableSpendUsd).toBeNull();
  });
});

describe('reported usage stopping guard', () => {
  const usage = (input: number, output = 0) => ({input_tokens: input, output_tokens: output, total_tokens: input + output,
    input_tokens_details: {cached_tokens: input}, output_tokens_details: {reasoning_tokens: output}});
  it('deduplicates root/child snapshots and uses the greater aggregate instead of adding it', () => {
    const guard = new UsageGuard(DEFAULT_MODEL);
    guard.observeTurn('s', {id: 'root', usage: usage(1000)});
    guard.observeTurn('s', {id: 'root', usage: usage(1000)});
    guard.observeTurn('s', {id: 'child', usage: usage(2000)});
    guard.observeSession('s', usage(3000));
    expect(guard.snapshot().estimateUsd).toBeCloseTo(0.0015);
    guard.observeTurn('s', {id: 'root', usage: usage(0)});
    guard.observeSession('s', usage(0));
    expect(guard.snapshot().estimateUsd).toBeCloseTo(0.0015);
  });
  it('includes reasoning within output once, ignores cache discounts, and stops at the trial threshold', () => {
    const guard = new UsageGuard(DEFAULT_MODEL);
    guard.observeTurn('s', {id: 'root', usage: usage(400_000)});
    expect(guard.snapshot().estimateUsd).toBeCloseTo(0.2);
    expect(() => guard.check('s')).toThrow('TRIAL_SPEND_THRESHOLD');
    const other = new UsageGuard(DEFAULT_MODEL);
    other.observeTurn('s', {id: 'root', usage: usage(0, 10_000)});
    expect(other.snapshot().estimateUsd).toBeCloseTo(0.018);
  });
  it('stops on total study usage, missing turns, invalid counts, or a different model', () => {
    const guard = new UsageGuard(DEFAULT_MODEL, 0.02, 0.02);
    guard.observeTurn('a', {id: 'root', usage: usage(20_000)});
    guard.observeTurn('b', {id: 'root', usage: usage(20_000)});
    expect(() => guard.check('b')).toThrow('STUDY_SPEND_THRESHOLD');
    guard.observeTurn('c', {id: 'child', usage: null});
    expect(() => guard.requireComplete('c')).toThrow('FINAL_USAGE_INCOMPLETE');
    expect(() => guard.observeSession('d', usage(-1))).toThrow('INVALID_USAGE_COUNTS');
    expect(() => guard.observeModel('different-model')).toThrow('UNEXPECTED_BILLED_MODEL');
  });
  it('includes the previous attempt without treating its usage as current-session telemetry', () => {
    const guard = new UsageGuard(DEFAULT_MODEL, 2, 0.2, 1.99);
    expect(guard.hasUsage('new')).toBe(false);
    guard.observeTurn('new', {id: 'root', usage: usage(20_000)});
    expect(() => guard.check('new')).toThrow('STUDY_SPEND_THRESHOLD');
  });
});

describe('function and evidence integrity', () => {
  const action = { type: 'function_call' as const, name: 'tracer_fixture', arguments: {}, call_id: 'c1', turn_id: 't1' };
  it('reuses identical calls, rejects changed duplicates and new calls repeating a logical operation', () => {
    const log = evidence(); const ledger = new FunctionLedger(trial, log);
    expect(ledger.handle('s', action)).toBe(ledger.handle('s', action));
    expect(() => ledger.handle('s', { ...action, arguments: { x: 1 } })).toThrow('CHANGED_DUPLICATE');
    expect(() => ledger.handle('s', { ...action, call_id: 'c2' })).toThrow('REPEATED_LOGICAL');
    expect(verifyLog(join(log.directory, 'events.jsonl'))).toBe(2);
  });
  it.each(['duplicate', 'missing', 'stale', 'extra'])('rejects %s results', mutation => {
    const ledger = new FunctionLedger(trial, evidence()); ledger.handle('s', action);
    const value = answers();
    if (mutation === 'duplicate') value.results[1] = value.results[0]!;
    if (mutation === 'missing') value.results.pop();
    if (mutation === 'stale') value.results[0]!.value = 'previous-run';
    if (mutation === 'extra') value.results.push({ key: 'extra', value: '' });
    ledger.handle('s', { ...action, name: 'tracer_submit', call_id: 'c2', arguments: value });
    expect(ledger.correct).toBe(false);
  });
  it('checks exact results independently of the model final answer', () => {
    const ledger = new FunctionLedger(trial, evidence()); ledger.handle('s', action);
    ledger.handle('s', { ...action, name: 'tracer_submit', call_id: 'c2', arguments: answers() });
    expect(ledger.correct).toBe(true);
  });
  it('detects tampering and redacts configured secrets', () => {
    const log = evidence(); log.record('test', { token: 'fake-test-secret' });
    const file = join(log.directory, 'events.jsonl');
    expect(readFileSync(file, 'utf8')).not.toContain('fake-test-secret');
    expect(verifyLog(file)).toBe(1);
    writeFileSync(file, readFileSync(file, 'utf8').replace('REDACTED', 'CHANGED'));
    expect(() => verifyLog(file)).toThrow('EVIDENCE_CHAIN_INVALID');
  });
  it('collects all pages and refuses a non-terminating page sequence', async () => {
    const page2 = { data: [2], hasNextPage: () => false, getNextPage: vi.fn() };
    const page1 = { data: [1], hasNextPage: () => true, getNextPage: async () => page2 };
    expect(await allPages(Promise.resolve(page1), evidence(), 'items')).toEqual([1, 2]);
    interface TestPage { data: number[]; hasNextPage(): boolean; getNextPage(): Promise<TestPage> }
    const forever: TestPage = { data: [1], hasNextPage: () => true, getNextPage: async () => forever };
    await expect(allPages(Promise.resolve(forever), evidence(), 'items')).rejects.toThrow('PAGE_CAP');
  });
});

describe('falsification decisions', () => {
  function cohort(): TrialEvidence[] {
    return matrix('cohort-seed', 'test-model').map(t => ({ block: t.block, arm: t.arm, sessionId: t.id,
      terminal: 'agent.session.turn.completed', taskCorrect: true, historyComplete: true,
      completedChildren: t.arm === 'programmatic-local' ? 0 : 2, error: null,
      route: 'unestablished', review: { decision: 'executed' } }));
  }
  it('never treats correct strings and child IDs as proof of the route', () => {
    const rows = cohort(); rows.forEach(r => { r.review = { decision: 'unestablished' }; });
    expect(decide(rows).outcome).toBe('inconclusive');
  });
  it('supports only all three controlled and independently reviewed blocks', () => {
    expect(decide(cohort()).outcome).toBe('supported');
  });
  it('returns a clean negative for repeated verified runtime rejection', () => {
    const rows = cohort();
    rows.filter(r => r.arm === 'programmatic-native').forEach(r => {
      r.taskCorrect = false; r.completedChildren = 0;
      r.review = { decision: 'runtime-rejected', rejectionCategory: 'native-not-callable' };
    });
    expect(decide(rows).outcome).toBe('refuted');
    rows.find(r => r.arm === 'programmatic-native')!.review = { decision: 'unestablished' };
    expect(decide(rows).outcome).toBe('refuted');
  });
  it('does not call control failures or mixed availability a categorical negative', () => {
    const rows = cohort(); const native = rows.find(r => r.arm === 'programmatic-native')!;
    native.review = { decision: 'runtime-rejected', rejectionCategory: 'native-not-callable' };
    native.taskCorrect = false;
    expect(decide(rows).reason).toBe('MIXED_BETA_BEHAVIOR');
    rows.forEach(r => { r.taskCorrect = false; });
    expect(decide(rows).outcome).toBe('inconclusive');
  });
  it('refuses reuse of a session and incomplete studies', () => {
    const rows = cohort(); rows[1]!.sessionId = rows[0]!.sessionId;
    expect(decide(rows).outcome).toBe('inconclusive');
    expect(decide([]).outcome).toBe('inconclusive');
  });
});

describe('official SDK transport, synthetic HTTP only', () => {
  function json(data: unknown) { return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); }
  function sse(events: unknown[]) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
  const session = { id: 'session-test', required_actions: [], usage: null, status: 'idle' };
  const terminal = { event_id: 'end', type: 'agent.session.turn.completed', session_id: session.id,
    turn_id: 'turn-test', turn: { id: 'turn-test', subagent_id: null, status: 'completed', usage: null } };
  it('cancels managed work when reported usage reaches the trial stopping threshold', async () => {
    let cancelled = false;
    const current = {...session, agent: {model: DEFAULT_MODEL}};
    const usage = {input_tokens: 400_000, output_tokens: 0, total_tokens: 400_000,
      input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}};
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/agents/sessions')) return sse([
        {event_id: 'created', type: 'agent.session.created', session: current},
        {...terminal, turn: {...terminal.turn, usage}},
      ]);
      if (init?.method === 'POST') {cancelled = true; return new Response(null, {status: 204});}
      return json(current);
    });
    const result = await collectTrial(new OpenAI({apiKey: 'fake-test-secret', maxRetries: 0, fetch: mock}),
      trial, evidence(), new UsageGuard(DEFAULT_MODEL));
    expect(cancelled).toBe(true);
    expect(result.error).toMatchObject({localReason: 'TRIAL_SPEND_THRESHOLD'});
  });
  it('allows delayed usage until the trial deadline and then cancels a silent live stream', async () => {
    vi.useFakeTimers(); let cancelled = false; let usageReads = 0;
    const current = {...session, agent: {model: DEFAULT_MODEL}};
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/agents/sessions')) {
        const stream = new ReadableStream<Uint8Array>({start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({event_id: 'created', type: 'agent.session.created', session: current})}\n\n`));
          init.signal?.addEventListener('abort', () => controller.error(new Error('MOCK_ABORT')));
        }});
        return new Response(stream, {headers: {'content-type': 'text/event-stream'}});
      }
      if (init?.method === 'POST') {cancelled = true; return new Response(null, {status: 204});}
      if (new URL(String(input)).pathname.endsWith('/turns')) {usageReads++; return json({data: [terminal.turn], has_more: false});}
      return json(current);
    });
    const collecting = collectTrial(new OpenAI({apiKey: 'fake-test-secret', maxRetries: 0, fetch: mock}),
      trial, evidence(), new UsageGuard(DEFAULT_MODEL));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(LIMITS.deadlineMs - 30_000);
    const result = await collecting;
    expect(usageReads).toBeGreaterThanOrEqual(11); expect(cancelled).toBe(true);
    expect(result.error).toMatchObject({localReason: 'TRIAL_DEADLINE'});
  });
  it('still cancels if the evidence log reaches its cap', async () => {
    const log = evidence(); const original = log.record.bind(log); let cancelled = false;
    vi.spyOn(log, 'record').mockImplementation((kind, data) => {
      if (kind === 'sse') throw new Error('EVIDENCE_BYTE_CAP');
      original(kind, data);
    });
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/agents/sessions'))
        return sse([{ event_id: 'created', type: 'agent.session.created', session }]);
      if (init?.method === 'POST') { cancelled = true; return new Response(null, { status: 204 }); }
      return json(session);
    });
    const result = await collectTrial(new OpenAI({ apiKey: 'fake-test-secret', maxRetries: 0, fetch: mock }), trial, log);
    expect(cancelled).toBe(true); expect(result.sessionId).toBe(session.id);
    expect(result.error).toMatchObject({ localReason: 'EVIDENCE_BYTE_CAP' });
  });
  it('times out a silent stream and sends cancellation instead of merely closing SSE', async () => {
    vi.useFakeTimers(); let cancelled = false;
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/agents/sessions')) {
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ event_id: 'created', type: 'agent.session.created', session })}\n\n`));
          init.signal?.addEventListener('abort', () => controller.error(new Error('MOCK_ABORT')));
        } });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (init?.method === 'POST') { cancelled = true; return new Response(null, { status: 204 }); }
      return json(session);
    });
    const collecting = collectTrial(new OpenAI({ apiKey: 'fake-test-secret', maxRetries: 0, fetch: mock }), trial, evidence());
    await vi.advanceTimersByTimeAsync(LIMITS.deadlineMs + 1);
    const result = await collecting;
    expect(cancelled).toBe(true); expect(result.terminal).toBeNull(); expect(result.error).not.toBeNull();
  });
  it('retains null usage and never promotes an idle event or child completion into root success', async () => {
    const log = evidence(); let creates = 0; let cancel = false;
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/agents/sessions')) {
        creates++;
        return sse([{ event_id: 'created', type: 'agent.session.created', session },
          { event_id: 'idle', type: 'agent.session.idle', session },
          { ...terminal, turn: { ...terminal.turn, subagent_id: 'child-only' } }]);
      }
      if (init?.method === 'POST' && url.endsWith('/events')) { cancel = true; return new Response(null, { status: 204 }); }
      if (url.endsWith(`/agents/sessions/${session.id}`)) return json(session);
      throw new Error('UNEXPECTED_MOCK_REQUEST');
    });
    const client = new OpenAI({ apiKey: 'fake-test-secret', maxRetries: 0, fetch: mock });
    const result = await collectTrial(client, trial, log);
    expect(creates).toBe(1); expect(cancel).toBe(true);
    expect(result.terminal).toBeNull(); expect(result.taskCorrect).toBeNull();
    expect(result.error).toMatchObject({ localReason: 'STREAM_ENDED_WITHOUT_ROOT_TERMINAL' });
  });
  it('handles real SDK SSE parsing, pending calls, paginated history and exact oracle checking', async () => {
    const local = matrix('sdk-test', 'test-model').find(t => t.arm === 'programmatic-local')!;
    const log = evidence(); let submitted = 0; const cursorUrls: string[] = [];
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); const parsed = new URL(url);
      expect(new Headers(init?.headers).get('OpenAI-Beta')).toBe('agents=v1');
      if (init?.method === 'POST' && url.endsWith('/agents/sessions')) return sse([
        { event_id: 'created', type: 'agent.session.created', session },
        { event_id: 'tool1', type: 'agent.session.requires_action', session },
        { event_id: 'tool2', type: 'agent.session.requires_action', session }, terminal,
      ]);
      if (init?.method === 'POST' && url.endsWith('/events')) {
        const body = JSON.parse(String(init.body));
        expect(body.events[0].turn_id).toBe('turn-test');
        submitted++; return new Response(null, { status: 204 });
      }
      if (url.endsWith(`/agents/sessions/${session.id}`)) return json({ ...session,
        required_actions: submitted < 2 ? [{ type: 'function_call', turn_id: 'turn-test', call_id: `c${submitted}`,
          name: submitted === 0 ? 'tracer_fixture' : 'tracer_submit', arguments: submitted === 0 ? {} : answers(local) }] : [] });
      if (parsed.pathname.endsWith('/items')) {
        cursorUrls.push(url);
        return json(parsed.searchParams.has('after') ? { data: [{ id: 'i2' }], has_more: false } :
          { data: [{ id: 'i1' }], has_more: true, last_id: 'i1' });
      }
      if (parsed.pathname.endsWith('/turns')) return json({ data: [terminal.turn], has_more: false });
      if (parsed.pathname.endsWith('/subagents')) return json({ data: [], has_more: false });
      throw new Error('UNEXPECTED_MOCK_REQUEST');
    });
    const result = await collectTrial(new OpenAI({ apiKey: 'fake-test-secret', maxRetries: 0, fetch: mock }), local, log);
    expect(result).toMatchObject({ taskCorrect: true, historyComplete: true, route: 'unestablished', error: null });
    expect(cursorUrls).toHaveLength(2); expect(cursorUrls[1]).toContain('after=i1');
    expect(readFileSync(join(log.directory, 'events.jsonl'), 'utf8')).toContain('"usage":null');
    expect(submitted).toBe(2);
  });
});
