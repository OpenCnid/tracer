import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionCounter, authorizePaidInference, boundedFetch } from '../src/budget.js';
import { allPages, collectTrial, FunctionLedger } from '../src/collector.js';
import { decide, type TrialEvidence } from '../src/decision.js';
import { Evidence, verifyLog } from '../src/evidence.js';
import { fixture, LIMITS, matrix, requestFor } from '../src/protocol.js';
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
