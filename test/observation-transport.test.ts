import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {readOnlyRetryFetch} from '../src/observation-transport.js';
import {Evidence,verifyLog} from '../src/evidence.js';
import {boundedFetch,UsageGuard} from '../src/budget.js';
import {auditedRecovery} from '../src/observation-resume-replay.js';
import {replayObservation} from '../src/observation-replay.js';

it('retries read-only connection and HTTP failures twice; never retries POST or local caps',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'tracer-read-only-'));
  try {
    const log=new Evidence(directory),waits:number[]=[];let calls=0;
    const base:typeof fetch=async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');return new Response('',{status:calls===2?503:200});};
    const retry=readOnlyRetryFetch(base,log,async n=>{waits.push(n);});
    expect((await retry('https://example.test/read')).status).toBe(200);expect(calls).toBe(3);expect(waits).toEqual([500,1000]);
    let posts=0;await expect(readOnlyRetryFetch(async()=>{posts++;throw new TypeError('fetch failed');},log)('https://example.test/paid',{method:'POST'})).rejects.toThrow();expect(posts).toBe(1);
    let caps=0;await expect(readOnlyRetryFetch(async()=>{caps++;throw new Error('HTTP_REQUEST_CAP');},log)('https://example.test/read')).rejects.toThrow('HTTP_REQUEST_CAP');expect(caps).toBe(1);
    let failed=0;await expect(readOnlyRetryFetch(async()=>{failed++;throw new TypeError('fetch failed');},log,async()=>{})('https://example.test/read')).rejects.toThrow();expect(failed).toBe(3);
    let physical=0;const capped=readOnlyRetryFetch(boundedFetch(async()=>{physical++;return new Response('',{status:503});}),log,async()=>{});
    for(let i=0;i<12;i++) await capped('https://example.test/items');
    await expect(capped('https://example.test/items')).rejects.toThrow('HTTP_REQUEST_CAP');expect(physical).toBe(36);
    expect(verifyLog(join(directory,'events.jsonl'))).toBeGreaterThan(2);
  } finally {if(!resolve(directory).startsWith(resolve(tmpdir())+sep)||!directory.includes('tracer-read-only-'))throw new Error('UNSAFE_CLEANUP');rmSync(directory,{recursive:true});}
});

it('adopts the completed first control without paying for its eleven turns twice',()=>{
  const read=(p:string)=>JSON.parse(readFileSync(p,'utf8')),reg=read('evidence/preregistration-v10-cohort.json');
  expect(auditedRecovery(join(reg.parent,'b1-control'))).toMatchObject({pass:true,operations:3,pendingExecuted:2,firstCheckpointReportCorrect:true,firstRecordReportCorrect:true});
  const prior=read(join(reg.parent,'managed-reconciliation.json')).reconciliation[0],guard=new UsageGuard('gpt-5.6-luna',2,.5,reg.priorAdmissionUsd);
  for(let repeat=0;repeat<2;repeat++) {guard.observeSession(prior.session.id,prior.session.usage);for(const t of prior.turns)guard.observeTurn(prior.session.id,t);}
  guard.requireComplete(prior.session.id);expect(guard.snapshot().admissionEstimateUsd).toBeCloseTo(.4721708,10);
  expect(guard.snapshot().sessions[0]!.turns).toHaveLength(11);
});

it('carries all three sessions and retains the second control collection failure',()=>{
  const read=(p:string)=>JSON.parse(readFileSync(p,'utf8')),reg=read('evidence/preregistration-v10-finish.json');
  const saved=read(join(reg.parent,'managed-reconciliation.json')),guard=new UsageGuard('gpt-5.6-luna',2,.5,reg.priorAdmissionUsd);
  for(const s of saved.reconciliation) {guard.observeSession(s.session.id,s.session.usage);for(const t of s.turns)guard.observeTurn(s.session.id,t);guard.requireComplete(s.session.id);}
  expect(guard.snapshot().admissionEstimateUsd).toBeCloseTo(.9624903,10);
  expect(guard.snapshot().sessions.reduce((n,s)=>n+s.turns.length,0)).toBe(31);
  expect(auditedRecovery(join(reg.parent,'b2-control'))).toMatchObject({pass:false,complete:false,pendingExecuted:2,checkpointReports:[true],recordReports:[true]});
  expect(read(join(reg.parent,'b2-control/result.json')).error).toBe('CURRENT_TURN_UNESTABLISHED');
});

it('verifies the third control independently and carries all five sessions into the last case',()=>{
  const read=(p:string)=>JSON.parse(readFileSync(p,'utf8')),reg=read('evidence/preregistration-v10-last.json');
  const saved=read(join(reg.parent,'managed-reconciliation.json')),guard=new UsageGuard('gpt-5.6-luna',2,.5,reg.priorAdmissionUsd);
  for(const s of saved.reconciliation) {guard.observeSession(s.session.id,s.session.usage);for(const t of s.turns)guard.observeTurn(s.session.id,t);guard.requireComplete(s.session.id);}
  expect(guard.snapshot().admissionEstimateUsd).toBeCloseTo(1.4448626,10);
  expect(guard.snapshot().sessions.reduce((n,s)=>n+s.turns.length,0)).toBe(51);
  expect(auditedRecovery(join(reg.parent,'b3-control'))).toMatchObject({pass:true,complete:true,pendingExecuted:2,checkpointReports:[true],recordReports:[true]});
});

it('replays a carried detector even when the continuation has no new detector-lock file',()=>{
  const reg=JSON.parse(readFileSync('evidence/preregistration-v10-finish.json','utf8'));
  const replay=replayObservation(reg.parent);
  expect(replay.calibration.rule).toEqual({fraction:.5,absolute:2048,confirmations:2});
  expect(replay.sourceMatches.every((s:{recordedCommitMatches:boolean})=>s.recordedCommitMatches)).toBe(true);
});
