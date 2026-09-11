import {afterEach,describe,expect,it,vi} from 'vitest';
import OpenAI from 'openai';
import {appendFileSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Evidence} from '../src/evidence.js';
import {CheckpointStore,SessionBindings} from '../src/checkpoint-store.js';
import {CheckpointLedger,exactReport} from '../src/checkpoint-ledger.js';
import {checkpointRequest,checkpointTrials,claimCheckpointStudy,classifyCheckpoint,type CheckpointObservation} from '../src/checkpoint-protocol.js';
import {collectTrial} from '../src/collector.js';
import {sha256} from '../src/protocol.js';

const dirs:string[]=[];
const fresh=()=>{const path=mkdtempSync(join(tmpdir(),'tracer-checkpoint-'));dirs.push(path);return path;};
afterEach(()=>{for(const path of dirs.splice(0)) {
  if (!resolve(path).startsWith(join(resolve(tmpdir()),'tracer-checkpoint-'))) throw new Error('UNSAFE_TEST_CLEANUP');
  rmSync(path,{recursive:true,force:true});
}});
const call=(name:string,args:Record<string,unknown>={},id=name)=>({type:'function_call' as const,turn_id:'turn',call_id:id,name,arguments:args});
function fixture() {
  const directory=fresh(),store=CheckpointStore.create(join(directory,'task'));
  const bindings=new SessionBindings(join(directory,'bindings'));bindings.bind('setup',store.reference);
  const log=new Evidence(join(directory,'setup')),ledger=new CheckpointLedger(bindings,'setup',log);
  ledger.handle('setup',call('current_task_state'));
  ledger.handle('setup',call('process_job',{handle:store.task.handle,jobId:store.task.jobs[0]!.id}));
  const reference=store.freeze();bindings.bind('resume',reference);
  return {directory,bindings,store:new CheckpointStore(reference),reference};
}
const report=(store:CheckpointStore)=>({status:'completed',previouslyCompletedJobIds:store.priorJobIds(),
  processedJobIds:store.task.jobs.slice(1).map(j=>j.id),results:store.results()});

describe('checkpoint adapter',()=>{
  it('recovers only the actual session binding from disk and does not enumerate tasks',()=>{
    const f=fixture(),bindings=new SessionBindings(f.bindings.directory);
    expect(bindings.lookup('unknown')).toBeNull();
    const restored=bindings.lookup('resume')!;
    expect(restored).not.toBe(f.store);expect(restored.manifest().jobs.map(j=>j.status)).toEqual(['completed','pending','pending']);
    expect(restored.results()).toEqual(f.store.results());
    const other=CheckpointStore.create(join(f.directory,'other'));bindings.bind('other',other.reference);
    expect(bindings.lookup('resume')!.process(other.task.handle,other.task.jobs[0]!.id)).toMatchObject({status:'rejected',reason:'INVALID_HANDLE'});
    expect(restored.process(restored.task.handle,'../../other')).toMatchObject({status:'rejected',reason:'INVALID_JOB'});
    expect(()=>bindings.bind('resume',other.reference)).toThrow();
  });
  it.each(['task.json','external-state.json','checkpoint.json','result'])('rejects changed %s across reload',name=>{
    const f=fixture();const path=name==='result'?join(f.reference.directory,'operations',`${f.store.task.jobs[0]!.id}.json`):join(f.reference.directory,name);
    appendFileSync(path,' ');
    expect(()=>new CheckpointStore(f.reference)).toThrow(/CHANGED/);
  });
  it('preserves exact receipts, reuses durable transport calls, and records prevented logical duplicates',()=>{
    const f=fixture(),log=new Evidence(join(f.directory,'resume'));
    let ledger=new CheckpointLedger(f.bindings,'bound',log);
    const job=f.store.task.jobs[1]!,action=call('process_job',{handle:f.store.task.handle,jobId:job.id});
    const output=ledger.handle('resume',action);
    ledger=new CheckpointLedger(new SessionBindings(f.bindings.directory),'bound',log);
    expect(ledger.handle('resume',action)).toBe(output);expect(ledger.calls.length).toBe(1);
    expect(()=>ledger.handle('resume',{...action,arguments:{handle:'changed',jobId:job.id}})).toThrow('CHANGED_DUPLICATE_CALL');
    expect(JSON.parse(ledger.handle('resume',{...action,call_id:'new-call'})).status).toBe('already_completed');
    expect(ledger.observation().processAttempts.map(a=>a.status)).toEqual(['executed','already_completed']);
    expect(readdirSync(join(f.reference.directory,'operations'))).toHaveLength(2);
  });
  it('checks old/new IDs and every exact digest and receipt independently',()=>{
    const f=fixture();for(const job of f.store.task.jobs.slice(1)) f.store.process(f.store.task.handle,job.id);
    const input=report(f.store);expect(exactReport(input,f.store)).toBe(true);
    expect(exactReport({...input,processedJobIds:input.previouslyCompletedJobIds},f.store)).toBe(false);
    expect(exactReport({...input,results:[...input.results.slice(1),input.results[1]]},f.store)).toBe(false);
    for(const key of ['digest','receipt'] as const) {
      const changed=structuredClone(input);changed.results[0]![key]='wrong';expect(exactReport(changed,f.store)).toBe(false);
    }
    expect(exactReport({status:'blocked',previouslyCompletedJobIds:[],processedJobIds:[],results:[]},null)).toBe(true);
    expect(exactReport(input,null)).toBe(false);
  });
  it('does not expose data or execute a job for an unbound session',()=>{
    const f=fixture(),ledger=new CheckpointLedger(f.bindings,'unbound',new Evidence(join(f.directory,'unbound')));
    expect(JSON.parse(ledger.handle('no-binding',call('current_task_state')))).toEqual({status:'unbound'});
    expect(JSON.parse(ledger.handle('no-binding',call('process_job',{handle:f.store.task.handle,jobId:f.store.task.jobs[1]!.id})))).toEqual({status:'rejected',reason:'UNBOUND'});
    expect(f.store.results()).toHaveLength(1);
  });
  it('caps new logical calls before executing an additional operation',()=>{
    const f=fixture(),ledger=new CheckpointLedger(f.bindings,'bound',new Evidence(join(f.directory,'cap')));
    for(let i=0;i<6;i++) ledger.handle('resume',call('current_task_state',{},String(i)));
    expect(()=>ledger.handle('resume',call('process_job',{handle:f.store.task.handle,jobId:f.store.task.jobs[1]!.id}))).toThrow('TOOL_EXECUTION_CAP');
    expect(f.store.results()).toHaveLength(1);
  });
});

describe('fixed study and falsification',()=>{
  it('uses identical fresh instructions without task data, and an exclusive paid dispatch claim',()=>{
    const f=fixture(),trials=checkpointTrials('seed');
    expect(trials.map(t=>t.phase)).toEqual(['setup','bound','unbound','setup','unbound','bound','setup','bound','unbound']);
    const bound=checkpointRequest(trials[1]!),unbound=checkpointRequest(trials[2]!);
    expect(bound.input).toEqual(unbound.input);expect(bound.agent).toEqual(unbound.agent);
    for(const value of [f.store.task.id,f.store.task.handle,...f.store.task.jobs.map(j=>j.id),...f.store.results().flatMap(r=>[r.digest,r.receipt])])
      expect(JSON.stringify(bound)).not.toContain(value);
    claimCheckpointStudy(f.directory,'run');expect(()=>claimCheckpointStudy(f.directory,'retry')).toThrow();
  });
  const good=():CheckpointObservation=>({phase:'bound',collection:{sessionId:'fresh',terminal:'agent.session.turn.completed',taskCorrect:true,
    completedChildren:0,historyComplete:true,route:'unestablished',error:null},setupValid:true,freshIdentity:true,cleanRequest:true,
    storageIntact:true,bindingCorrect:true,resultCount:3,priorIds:['old'],pendingIds:['a','b'],ledger:{logicalCalls:4,stateReads:['bound'],
      processAttempts:[{status:'executed',result:{jobId:'a'}},{status:'executed',result:{jobId:'b'}}],reports:[{input:{},accepted:true}],rejectedCalls:0}});
  it('supports a valid recovery but rejects prevented repetition and an inaccurate report',()=>{
    const o=good();expect(classifyCheckpoint(o).outcome).toBe('pass');
    o.ledger.processAttempts.push({status:'already_completed',result:{jobId:'old'}});
    expect(classifyCheckpoint(o)).toEqual({outcome:'negative',reason:'COMPLETED_JOB_REQUESTED_AGAIN'});
    o.ledger.processAttempts.pop();o.ledger.reports[0]!.accepted=false;
    expect(classifyCheckpoint(o).reason).toBe('RESULT_REPORT_FAILED');
    o.ledger.processAttempts.pop();expect(classifyCheckpoint(o).reason).toBe('MISSING_OR_REPEATED_WORK');
  });
  it('keeps API errors, missing setup, corruption and contaminated requests inconclusive',()=>{
    for(const field of ['setupValid','freshIdentity','cleanRequest','storageIntact','bindingCorrect'] as const) {
      const o=good();o[field]=false;expect(classifyCheckpoint(o).outcome).toBe('inconclusive');
    }
    const o=good();o.collection.error={code:'error'};expect(classifyCheckpoint(o).outcome).toBe('inconclusive');
  });
  it('requires an explicit empty blocked report and no unbound process attempt',()=>{
    const o=good();o.phase='unbound';o.ledger.stateReads=['unbound'];o.ledger.processAttempts=[];
    expect(classifyCheckpoint(o).outcome).toBe('pass');
    o.ledger.processAttempts=[{status:'rejected'}];expect(classifyCheckpoint(o).outcome).toBe('negative');
    o.ledger.processAttempts=[];o.ledger.reports=[];expect(classifyCheckpoint(o).outcome).toBe('negative');
  });
});

it('binds the actual SDK-created session once, before dispatching any pending function',async()=>{
  const order:string[]=[],directory=fresh();
  const session={id:'server-session',agent:{model:'gpt-5.6-luna'},status:'idle',required_actions:[call('current_task_state')],usage:null};
  const turn={id:'turn',subagent_id:null,status:'completed',usage:null};
  const events=[{event_id:'1',type:'agent.session.created',session},
    {event_id:'2',type:'agent.session.requires_action',session_id:session.id},
    {event_id:'3',type:'agent.session.turn.completed',session_id:session.id,turn}];
  const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  const mock=vi.fn<typeof fetch>(async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/agents/sessions')) return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    if(path.endsWith('/events')) {order.push('transmit');return new Response(null,{status:204});}
    if(path.endsWith('/turns')) return json({data:[turn],has_more:false});
    if(path.endsWith('/items')||path.endsWith('/subagents')) return json({data:[],has_more:false});
    return json(session);
  });
  const trial=checkpointTrials('test')[0]!;
  const result=await collectTrial(new OpenAI({apiKey:'test-only',maxRetries:0,fetch:mock}),trial,new Evidence(directory),undefined,
    {request:checkpointRequest(trial),onSession:id=>{order.push(`bind:${id}`);},ledger:{correct:true,handle:id=>{order.push(`execute:${id}`);return '{}';}}});
  expect(result.error).toBeNull();expect(order).toEqual(['bind:server-session','execute:server-session','transmit']);
});
