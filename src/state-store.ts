import {randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentSession} from 'openai/resources/beta/agents/agents';
import {AdmissionCounter} from './budget.js';
import {Evidence} from './evidence.js';
import {sha256} from './protocol.js';

export const RECORD_COUNT = 512;
export interface StateRecord {index: number; value: string}
export class StateStore {
  readonly path: string;
  readonly handle: string;
  readonly sha256: string;
  readonly bytes: number;
  constructor(directory: string) {
    this.path = join(directory, 'external-state.json');
    this.handle = `state_${randomBytes(24).toString('hex')}`;
    const content = JSON.stringify({handle: this.handle, records: Array.from({length: RECORD_COUNT}, (_, index) => ({
      index, value: randomBytes(1024).toString('hex'),
    }))}) + '\n';
    writeFileSync(this.path, content, {flag: 'wx'});
    this.sha256 = sha256(content); this.bytes = Buffer.byteLength(content);
  }
  manifest() { return {handle: this.handle, recordCount: RECORD_COUNT}; }
  read(handle: string, indices: number[]): StateRecord[] {
    if (handle !== this.handle) throw new Error('INVALID_STATE_HANDLE');
    if (!Array.isArray(indices) || indices.length !== 2 || new Set(indices).size !== 2 ||
        !indices.every(i => Number.isInteger(i) && i >= 0 && i < RECORD_COUNT)) throw new Error('INVALID_STATE_INDICES');
    const content = readFileSync(this.path);
    if (sha256(content) !== this.sha256) throw new Error('EXTERNAL_STATE_CHANGED');
    const state = JSON.parse(content.toString('utf8')) as {handle: string; records: StateRecord[]};
    if (state.handle !== this.handle) throw new Error('EXTERNAL_STATE_CHANGED');
    return indices.map(i => state.records[i]!);
  }
  integrity() {return {path: this.path, expectedSha256: this.sha256,
    actualSha256: sha256(readFileSync(this.path)), bytes: this.bytes};}
}

type FunctionAction = Extract<AgentSession['required_actions'][number], {type: 'function_call'}>;
export class StateLedger {
  readonly saved = new Map<string, {arguments: string; output: string}>();
  readonly names = new Set<string>();
  private readonly counter = new AdmissionCounter();
  correct: boolean | null = null;
  constructor(readonly store: StateStore, readonly phase: 'setup' | 'lookup', readonly evidence: Evidence,
    readonly indices?: number[]) {}
  handle(sessionId: string, action: FunctionAction) {
    const key = `${sessionId}:${action.turn_id}:${action.call_id}`;
    const args = JSON.stringify({name: action.name, arguments: action.arguments});
    const old = this.saved.get(key);
    if (old) {
      if (old.arguments !== args) throw new Error('CHANGED_DUPLICATE_CALL');
      this.evidence.record('function.reused', {key}); return old.output;
    }
    if (this.names.has(action.name)) throw new Error('REPEATED_LOGICAL_TOOL');
    const input = action.arguments as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_TOOL_ARGUMENTS');
    let value: unknown;
    if (this.phase === 'setup' && action.name === 'tracer_manifest' && Object.keys(input).length === 0) {
      value = this.store.manifest();
    } else if (this.phase === 'lookup' && action.name === 'tracer_state_read') {
      if (Object.keys(input).sort().join(',') !== 'handle,indices' ||
          JSON.stringify(input.indices) !== JSON.stringify(this.indices)) throw new Error('WRONG_QUERY_INDICES');
      value = {records: this.store.read(input.handle as string, input.indices as number[])};
    } else if (this.phase === 'lookup' && action.name === 'tracer_state_submit') {
      if (!this.names.has('tracer_state_read')) throw new Error('SUBMIT_BEFORE_STATE_READ');
      const expected = this.store.read(this.store.handle, this.indices!);
      const rows = input.records;
      this.correct = Object.keys(input).join(',') === 'records' && Array.isArray(rows) && rows.length === 2 &&
        expected.every(wanted => rows.filter(row => row && typeof row === 'object' &&
          Object.keys(row).sort().join(',') === 'index,value' && row.index === wanted.index && row.value === wanted.value).length === 1);
      value = {accepted: this.correct};
    } else throw new Error('UNEXPECTED_PHASE_TOOL');
    const output = JSON.stringify(value); this.counter.admit(output);
    this.evidence.record('function.executed', {key, action, output, stateSha256: this.store.sha256});
    this.saved.set(key, {arguments: args, output}); this.names.add(action.name);
    return output;
  }
}
