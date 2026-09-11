import {afterEach, describe, expect, it, vi} from 'vitest';
import OpenAI from 'openai';
import {appendFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {StateLedger, StateStore} from '../src/state-store.js';
import {stateQuery, stateRequest} from '../src/state-protocol.js';
import {decideState, type StateObservation} from '../src/state-decision.js';
import {collectTrial} from '../src/collector.js';
import {DEFAULT_MODEL, matrix} from '../src/protocol.js';
import {PRESSURE_BYTES} from '../src/followup-protocol.js';

const dirs: string[] = [];
const fresh = () => {const dir = mkdtempSync(join(tmpdir(), 'tracer-state-')); dirs.push(dir); return dir;};
afterEach(() => {for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});});
const action = {type: 'function_call' as const, turn_id: 'turn', call_id: 'call', name: 'tracer_manifest', arguments: {}};

describe('exact external state', () => {
  it('serves exact bytes by handle and rejects a missing locator or changed file', () => {
    const store = new StateStore(fresh());
    expect(store.bytes).toBeGreaterThan(1024 * 1024);
    const records = store.read(store.handle, [0, 511]);
    expect(records.map(r => r.value.length)).toEqual([2048, 2048]);
    expect(() => store.read('wrong-handle', [0, 511])).toThrow('INVALID_STATE_HANDLE');
    expect(() => store.read(store.handle, [0, 0])).toThrow('INVALID_STATE_INDICES');
    appendFileSync(store.path, ' ');
    expect(() => store.read(store.handle, [0, 511])).toThrow('EXTERNAL_STATE_CHANGED');
  });
  it('keeps the handle out of later queries and uses one exact fixed pressure dose', () => {
    const store = new StateStore(fresh());
    const trial = matrix('state', DEFAULT_MODEL)[1]!;
    expect(JSON.stringify(stateRequest(trial))).not.toContain(store.handle);
    const query = stateQuery([31, 421], true);
    expect(query.pressureBytes).toBe(PRESSURE_BYTES);
    expect(query.input).not.toContain(store.handle);
    expect(query.input).not.toContain(store.read(store.handle, [31, 421])[0]!.value);
    expect(stateQuery([31, 421], false).pressureBytes).toBe(0);
  });
  it('does not silently reissue the handle, fix query indices, or reexecute duplicate calls', () => {
    const dir = fresh(); const store = new StateStore(dir);
    const setup = new StateLedger(store, 'setup', new Evidence(join(dir, 'setup')));
    const manifest = setup.handle('session', action);
    expect(setup.handle('session', action)).toBe(manifest);
    expect(setup.saved.size).toBe(1);
    const lookup = new StateLedger(store, 'lookup', new Evidence(join(dir, 'lookup')), [1, 2]);
    expect(() => lookup.handle('session', action)).toThrow('UNEXPECTED_PHASE_TOOL');
    expect(() => lookup.handle('session', {...action, name: 'tracer_state_read',
      arguments: {handle: store.handle, indices: [2, 3]}})).toThrow('WRONG_QUERY_INDICES');
    expect(() => lookup.handle('session', {...action, name: 'tracer_state_read',
      arguments: {handle: 'wrong', indices: [1, 2]}})).toThrow('INVALID_STATE_HANDLE');
  });
  it.each([true, false])('checks the actual submitted data against immutable bytes (correct=%s)', correct => {
    const dir = fresh(); const store = new StateStore(dir);
    const ledger = new StateLedger(store, 'lookup', new Evidence(join(dir, 'lookup')), [1, 2]);
    const read = ledger.handle('session', {...action, name: 'tracer_state_read', arguments: {handle: store.handle, indices: [1, 2]}});
    const value = JSON.parse(read); if (!correct) value.records[0].value = 'wrong';
    ledger.handle('session', {...action, call_id: 'submit', name: 'tracer_state_submit', arguments: value});
    expect(ledger.correct).toBe(correct);
    expect(store.integrity().actualSha256).toBe(store.sha256);
  });
});

describe('compaction evidence classification', () => {
  const rows = (): StateObservation[] => [false, true, true].map(pressure => ({
    pressure, retrievalCorrect: true, stateIntact: true, boundaryVerified: false, locatorFailure: false,
  }));
  it('never promotes successful pressure retrieval into proof of compaction', () => {
    expect(decideState(rows()).outcome).toBe('inconclusive');
  });
  it('can support verified boundaries or falsify locator survival with an intact store', () => {
    const values = rows(); values.forEach(r => {r.boundaryVerified = r.pressure;});
    expect(decideState(values).outcome).toBe('supported-at-tested-boundaries');
    values[1]!.retrievalCorrect = false; values[1]!.locatorFailure = true;
    expect(decideState(values).outcome).toBe('refuted-for-tested-workflow');
    values[1]!.stateIntact = false;
    expect(decideState(values).outcome).toBe('inconclusive');
  });
});

describe('official SDK continuation transport', () => {
  it('subscribes before one input message and continues the same session without creating another', async () => {
    const order: string[] = [];
    const session = {id: 'existing-session', status: 'idle', required_actions: [], usage: null};
    const turn = {id: 'new-turn', subagent_id: null, status: 'completed', usage: null};
    const events = [{event_id: 'created', type: 'agent.session.turn.created', session_id: session.id, turn},
      {event_id: 'completed', type: 'agent.session.turn.completed', session_id: session.id, turn}];
    const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/agents/sessions')) throw new Error('UNEXPECTED_NEW_SESSION');
      if (path.endsWith('/events') && init?.method === 'POST') {
        const event = JSON.parse(String(init.body)).events[0]; order.push(event.type);
        return new Response(null, {status: 204});
      }
      if (path.endsWith('/events')) {
        order.push('subscribe');
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
      }
      if (path.endsWith('/items') || path.endsWith('/subagents')) return json({data: [], has_more: false});
      if (path.endsWith('/turns')) return json({data: [turn], has_more: false});
      return json(session);
    });
    const trial = matrix('state', DEFAULT_MODEL).find(t => t.arm === 'programmatic-local')!;
    const result = await collectTrial(new OpenAI({apiKey: 'test-only', maxRetries: 0, fetch: mock}), trial,
      new Evidence(fresh()), undefined, {continuation: {sessionId: session.id, input: 'Use the earlier handle.'}});
    expect(result).toMatchObject({sessionId: session.id, terminal: 'agent.session.turn.completed', error: null});
    expect(order).toEqual(['subscribe', 'agent.session.input.message']);
  });
});
