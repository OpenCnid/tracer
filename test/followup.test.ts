import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {collectionAgreement, followupRegistration, joinMatrix, joinRequest} from '../src/followup-protocol.js';
import {DEFAULT_MODEL, fixture} from '../src/protocol.js';

const dirs: string[] = [];
afterEach(() => {for (const path of dirs.splice(0)) rmSync(path, {recursive: true, force: true});});

describe('follow-up evidence', () => {
  it('binds the new frozen protocol and keeps six fresh trials separate from v4', () => {
    expect(followupRegistration().protocolHash).toMatch(/^[a-f0-9]{64}$/);
    const trials = joinMatrix('test', DEFAULT_MODEL);
    expect(trials).toHaveLength(6); expect(new Set(trials.map(t => t.seed)).size).toBe(6);
    expect(trials.filter(t => t.arm === 'programmatic-native')).toHaveLength(3);
    for (const trial of trials) {
      const request = joinRequest(trial);
      expect(request.metadata?.protocol).toBe('collect-all-v5');
      for (const task of fixture(trial).tasks) expect(JSON.stringify(request)).not.toContain(task.nonce);
    }
  });
  it.each([true, false])('separates collection agreement from child accuracy (complete=%s)', complete => {
    const trial = joinMatrix('test', DEFAULT_MODEL)[0]!;
    const directory = mkdtempSync(join(tmpdir(), 'tracer-agreement-')); dirs.push(directory);
    const log = new Evidence(directory); const tasks = fixture(trial).tasks;
    log.record('children', {data: tasks.map((t, i) => ({id: `child-${i}`, instructions: [{type: 'output_text', text: t.nonce}]}))});
    for (const [i] of tasks.entries()) {
      log.record(`child.items:child-${i}`, {data: [{type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{type: 'output_text', text: `wrong-answer-${i}`}]}]});
      log.record(`child.turns:child-${i}`, {data: [{status: 'completed'}]});
    }
    log.record('function.executed', {action: {name: 'tracer_submit', arguments: {results: tasks.map((t, i) => ({
      key: t.key, value: !complete && i === 1 ? 'undefined' : `wrong-answer-${i}`,
    }))}}});
    const result = collectionAgreement(directory, trial);
    expect(result.completeAgreement).toBe(complete);
    expect(result.results.every(r => 'childTaskCorrect' in r && r.childTaskCorrect === false)).toBe(true);
    expect(result.route).toBe('unestablished');
    expect(readFileSync(join(directory, 'events.jsonl'), 'utf8')).toContain('wrong-answer');
  });
});
