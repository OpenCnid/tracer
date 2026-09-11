import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import type {Turn} from 'openai/resources/beta/agents/sessions/turns';
import type {AgentSessionItem} from 'openai/resources/beta/agents/agents';
import {detect,chooseRule,calibrationPass,ObservationBudget,scoreRecall,calibrationFixture,recallQuery,studyFetch,type Sample,type Rule} from '../src/observation.js';
import {ackObservation,ObservationBindings,RecordLedger} from '../src/observation-managed.js';
import {CheckpointStore} from '../src/checkpoint-store.js';
import {CheckpointLedger,exactReport} from '../src/checkpoint-ledger.js';
import {Evidence} from '../src/evidence.js';

const rule:Rule={fraction:.75,absolute:2048,confirmations:2};
const samples=(counts:(number|null)[]):Sample[]=>counts.map((input,i)=>({id:`m${i}`,at:`t${i}`,input,cached:0,output:3,valid:input!==null,reasons:input===null?['MISSING_USAGE']:[]}));
describe('context observation independent of recovery',()=>{
  it('requires a persistent drop and reports an interval',()=>{
    expect(detect(samples([10000,10000,1800,1900,2000]),rule)).toMatchObject({before:'m1',drop:'m2',confirmed:'m4',interval:['t1','t4']});
    expect(detect(samples([10000,10000,1800,9000,2000]),rule)).toBeNull();
    expect(detect(samples([10000,10000,1800,1900]),rule)).toBeNull();
  });
  it('does not turn plateaus, cached savings, or missing samples into drops',()=>{
    expect(detect(samples([10000,10010,10011,10012,10013]),rule)).toBeNull();
    const cached=samples([10000,10000,10000,10000,10000]);cached.forEach((s,i)=>s.cached=i?9500:0);
    expect(detect(cached,rule)).toBeNull();
    expect(detect(samples([10000,null,1000,1000,1000]),rule)).toBeNull();
    expect(detect(samples([10000,1000,null,1000,1000]),rule)).toBeNull();
  });
  it('does not keep hunting after a failed first candidate',()=>{
    expect(detect(samples([10000,1000,10000,1000,1000,1000]),rule)).toBeNull();
  });
  it('chooses on development, rejects held-out false positives, and explicitly detects deletion',()=>{
    const t={full:samples([10000,10000,10000,10010,10020]),compact:samples([10000,10000,1000,1100,1200]),prefix:samples([10000,10000,2000,2100,2200]),rolling:samples([10000,10000,2000,1000,50])};
    expect(chooseRule(t)).toEqual(rule);expect(calibrationPass(t,rule)).toBe(true);
    expect(calibrationPass({...t,full:t.prefix},rule)).toBe(false);
    expect(chooseRule({...t,compact:t.full})).toBeNull();
  });
  it('recall questions never supply the answer and scores exact random facts',()=>{
    const f=calibrationFixture();const query=recallQuery(f.facts);
    expect(f.facts.every(x=>!query.includes(x.task)&&!query.includes(x.code))).toBe(true);
    expect(f.exchanges).toHaveLength(8);
    const x=f.facts[0]!;const scored=scoreRecall(JSON.stringify({[`${x.id}.task`]:x.task,[`${x.id}.code`]:null}),[x]);
    expect(scored.items[0]).toEqual({id:x.id,task:true,code:false});
    expect(scoreRecall('ACK',[x]).validJSON).toBe(false);
  });
  it('carries unknown reservations and refuses another call or allowance reset',()=>{
    const b=new ObservationBudget();b.reserve('compact',true);expect(b.snapshot().admissionEstimateUsd).toBe(.1);
    expect(()=>b.reserve('next',false)).toThrow('UNSETTLED_REQUEST');
    expect(()=>b.settle(null)).toThrow('MISSING_USAGE');
    b.settle({input_tokens:900000,output_tokens:0});expect(b.snapshot().estimateUsd).toBe(.45);
    expect(()=>b.reserve('next',true)).toThrow('CALIBRATION_ADMISSION_CAP');
  });
  it('stops on reported cost, even if the prior reservation was smaller',()=>{
    const b=new ObservationBudget();b.reserve('call',false);
    expect(()=>b.settle({input_tokens:1100000,output_tokens:0})).toThrow('CALIBRATION_SPEND_THRESHOLD');
    expect(b.snapshot().estimateUsd).toBe(.55);
  });
  it('enforces the HTTP dispatch cap with cleanup capacity',async()=>{
    let count=0;const http=studyFetch(async()=>{count++;return new Response('{}');});
    for(let i=0;i<2970;i++) await http.fetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}'});
    await expect(http.fetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}'})).rejects.toThrow('STUDY_HTTP_CAP');
    await http.fetch('https://api.openai.com/v1/agents/sessions/test',{method:'GET'});expect(count).toBe(2971);
  });
  it('rejects visible extra work and unstable accounting without assuming a generation count',()=>{
    const turn={id:'t',status:'completed',created_at:1,completed_at:2,usage:{input_tokens:10000,input_tokens_details:{cached_tokens:9000},output_tokens:1}} as Turn;
    const item={id:'m',type:'message',role:'assistant',turn_id:'t',content:[{type:'output_text',text:'ACK'}],phase:'final_answer',status:'completed'} as AgentSessionItem;
    expect(ackObservation('x',turn,[item],true,true)).toMatchObject({valid:true,input:10000,cached:9000});
    expect(ackObservation('x',turn,[item,item],true,true).valid).toBe(false);
    expect(ackObservation('x',turn,[item],false,true).valid).toBe(false);
  });
  it('freezes state in the same binding and allows corrected reports without repeating work',()=>{
    const path=mkdtempSync(join(tmpdir(),'tracer-observation-'));
    try {
      const store=CheckpointStore.create(join(path,'state')),bindings=new ObservationBindings(join(path,'bindings'));
      bindings.bind('session',store.reference);store.process(store.task.handle,store.task.jobs[0]!.id);
      bindings.freeze('session',store.freeze());const restored=bindings.lookup('session')!;
      expect(restored.priorJobIds()).toEqual([store.task.jobs[0]!.id]);
      expect(()=>bindings.freeze('session',restored.reference)).toThrow();
      const log=new Evidence(join(path,'log')),base=new CheckpointLedger(bindings,'bound',log),ledger=new RecordLedger(base,[4,9],log);
      const action=(name:string,args:unknown,id:string)=>({type:'function_call' as const,name,arguments:args,call_id:id,turn_id:'turn'});
      expect(JSON.parse(ledger.handle('session',action('tracer_state_read',{handle:'bad',indices:[4,9]},'bad') as any)).status).toBe('rejected');
      const call=action('tracer_state_read',{handle:store.task.handle,indices:[4,9]},'good') as any;
      const output=ledger.handle('session',call);expect(ledger.handle('session',call)).toBe(output);
      expect(()=>ledger.handle('session',{...call,arguments:{}})).toThrow('CHANGED_DUPLICATE_CALL');
      ledger.handle('session',action('tracer_state_submit',JSON.parse(output),'report') as any);expect(ledger.correct).toBe(true);
      for(const job of store.task.jobs.slice(1)) restored.process(store.task.handle,job.id);
      const report={status:'completed',previouslyCompletedJobIds:restored.priorJobIds(),processedJobIds:store.task.jobs.slice(1).map(j=>j.id),results:restored.results()};
      expect(exactReport({...report,results:[]},restored)).toBe(false);expect(exactReport(report,restored)).toBe(true);
      expect(JSON.parse(readFileSync(join(path,'state','checkpoint.json'),'utf8')).completed).toHaveLength(1);
    } finally {
      if(!resolve(path).startsWith(resolve(tmpdir())+sep) || !path.includes('tracer-observation-')) throw new Error('UNSAFE_TEST_CLEANUP');
      rmSync(path,{recursive:true,force:true});
    }
  });
});
