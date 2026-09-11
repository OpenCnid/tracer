import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import OpenAI from 'openai';
import {CarriedCalibrationBudget,missingCalibrationRequests,continuationRegistration,bridgePass,responseSample,
  claimContinuation,completeCalibration,FIXED_RULE} from '../src/observation-continuation.js';
import {Evidence} from '../src/evidence.js';
import {UsageGuard} from '../src/budget.js';
import {ackObservation,ObservationBindings,TransportUsageGuard,canRetryUnestablished,matchesCompletedAck} from '../src/observation-managed.js';
import type {Response as ModelResponse} from 'openai/resources/responses/responses';

const parent='evidence/runs/2026-09-11T13-13-03-969Z-context-observation-v9-d3b43f6e';
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
function cleanup(path:string) {
  if(!resolve(path).startsWith(resolve(tmpdir())+sep)||!path.includes('tracer-observation-continuation-')) throw new Error('UNSAFE_CLEANUP');
  rmSync(path,{recursive:true,force:true});
}
describe('carried observation continuation',()=>{
  it('adopts only a completed ACK with the exact originally requested input',()=>{
    const turn={id:'late',status:'completed',created_at:1,completed_at:2,usage:{input_tokens:8106,input_tokens_details:{cached_tokens:7800},output_tokens:5}} as any;
    const items=[{type:'message',turn_id:'late',role:'user',content:[{type:'input_text',text:'exact dose'}]},
      {type:'message',turn_id:'late',role:'assistant',content:[{type:'output_text',text:'ACK'}]}] as any;
    expect(matchesCompletedAck('exact dose',turn,items)).toBe(true);
    expect(matchesCompletedAck('different dose',turn,items)).toBe(false);
    expect(matchesCompletedAck('exact dose',{...turn,status:'failed'},items)).toBe(false);
    expect(matchesCompletedAck('exact dose',turn,[...items,{type:'function_call',turn_id:'late'}])).toBe(false);
    expect(matchesCompletedAck('exact dose',turn,[items[0],{...items[1],content:[{type:'output_text',text:'wrong'}]}])).toBe(false);
    expect(matchesCompletedAck('exact dose',{...turn,usage:null},items)).toBe(true);
    expect(ackObservation('dose', {...turn,usage:null},items,false,true).valid).toBe(false);
  });
  it('retains transport reservations and refuses retries when a new or active turn exists',()=>{
    const guard=new TransportUsageGuard('gpt-5.6-luna',2,.5,.37);guard.reserveUnestablished();
    expect(guard.snapshot().admissionEstimateUsd).toBeCloseTo(.57,10);
    const status={status:'idle',required_actions:[]} as any,turn={id:'old',status:'completed',usage:{input_tokens:10,output_tokens:1}} as any;
    expect(canRetryUnestablished(status,[turn],new Set(['old']),false)).toBe(true);
    expect(canRetryUnestablished(status,[],new Set(['old']),false)).toBe(false);
    expect(canRetryUnestablished(status,[turn,{...turn,id:'new'}],new Set(['old']),false)).toBe(false);
    expect(canRetryUnestablished({...status,status:'in_progress'},[turn],new Set(['old']),false)).toBe(false);
    expect(canRetryUnestablished(status,[{...turn,usage:null}],new Set(['old']),false)).toBe(false);
  });
  it('restores delayed usage into the same guard once, preserving the original binding',()=>{
    const reg=read('evidence/preregistration-v10-completion.json');
    const rows=readFileSync(reg.resolvedSnapshot,'utf8').trim().split('\n').map(l=>JSON.parse(l));
    const resolved=rows.find(e=>e.kind==='read-only.snapshot').data;
    const guard=new UsageGuard('gpt-5.6-luna',2,.5,.1720471);
    guard.observeSession(resolved.session.id,resolved.session.usage);
    for(const t of resolved.turns) guard.observeTurn(resolved.session.id,t);
    guard.requireComplete(resolved.session.id);
    expect(guard.snapshot().admissionEstimateUsd).toBeCloseTo(.1910812,10);
    expect(guard.snapshot().unknownTurnCount).toBe(0);
    expect(ackObservation('baseline-1',resolved.turns[1],resolved.items,true,true)).toMatchObject({input:7848,valid:true});
    const store=new ObservationBindings(join(reg.parent,'bindings')).lookup(resolved.session.id)!;
    expect(store.priorJobIds()).toHaveLength(1);store.verify();
  });
  it('does not release the historical reservation or settle it with the replacement usage',()=>{
    const b=new CarriedCalibrationBudget(.1328787,.03);expect(b.snapshot().admissionEstimateUsd).toBeCloseTo(.1628787,10);
    b.reserve('replacement');b.settle({input_tokens:1000,output_tokens:100});
    expect(b.snapshot().historicalUnresolvedReservationUsd).toBe(.03);
    expect(b.snapshot().knownEstimateUsd).toBeCloseTo(.1335587,10);
    expect(b.snapshot().admissionEstimateUsd).toBeCloseTo(.1635587,10);
  });
  it('blocks another call on new unknown usage and caps the continuation at six requests',()=>{
    const b=new CarriedCalibrationBudget(.1328787,.03);b.reserve('first');
    expect(()=>b.reserve('second')).toThrow('NEW_REQUEST_UNSETTLED');
    expect(()=>b.settle(null)).toThrow('MISSING_USAGE');
    b.settle({input_tokens:1,output_tokens:1});
    for(let i=1;i<6;i++){b.reserve(`call-${i}`);b.settle({input_tokens:1,output_tokens:1});}
    expect(()=>b.reserve('seventh')).toThrow('CONTINUATION_REQUEST_CAP');
    expect(()=>new CarriedCalibrationBudget(.49,.03).reserve('over')).toThrow('CALIBRATION_ADMISSION_CAP');
  });
  it('uses the frozen detector and reconstructs only the missing stateless requests',()=>{
    expect(continuationRegistration().detectorSourceHash).toBeTruthy();
    expect(FIXED_RULE).toEqual(read(join(parent,'detector-lock.json')).rule);
    const p=missingCalibrationRequests(parent);expect(p).toHaveLength(6);
    expect(p[0]!.body).toEqual(read(join(parent,'heldout-2/pre-2-request.json')));
    expect(p[1]!.body).toEqual(read(join(parent,'heldout-2/prefix-recall-request.json')));
    expect(p.every(r=>r.body.model==='gpt-5.6-luna' && r.body.store===false && r.body.stream===false)).toBe(true);
    const f=read(join(parent,'heldout-2/fixture.json'));
    expect(JSON.stringify(p[2]!.body.input)).toContain(f.facts[6].task);
    expect(JSON.stringify(p[3]!.body.input)).not.toContain(f.facts[6].task);
    expect(JSON.stringify(p[4]!.body.input)).not.toContain(f.facts[7].task);
    expect(JSON.stringify(p[4]!.body.input)).toContain(f.recent.code);
  });
  it('requires a stable bridge and refuses duplicate continuation claims',()=>{
    const s=responseSample('bridge',{status:'completed',output_text:'ACK',output:[],usage:{input_tokens:10043,input_tokens_details:{cached_tokens:9990},output_tokens:5}} as unknown as ModelResponse,'now');
    expect(bridgePass(s,10043)).toBe(true);expect(bridgePass({...s,input:11000},10043)).toBe(false);
    expect(bridgePass({...s,valid:false},10043)).toBe(false);
    const p=mkdtempSync(join(tmpdir(),'tracer-observation-continuation-'));
    try {claimContinuation(p,'first',parent);expect(()=>claimContinuation(p,'second',parent)).toThrow();expect(read(join(p,'dispatch-observation-v10.json')).newAllowance).toBe(false);}finally{cleanup(p);}
  });
  it('completes the saved fixture against mock HTTP without relearning a rule',async()=>{
    const p=mkdtempSync(join(tmpdir(),'tracer-observation-continuation-'));const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    try {
      let calls=0;
      const api=new OpenAI({apiKey:'mock',maxRetries:0,fetch:async()=>{
        const index=calls++,tokens=[10043,2750,2600,1360,150,200][index]!;
        return new Response(JSON.stringify({id:`mock-${index}`,object:'response',model:'gpt-5.6-luna',status:'completed',created_at:1,
          output:[{type:'message',role:'assistant',content:[{type:'output_text',text:index===1||index===5?'{}':'ACK'}]}],
          usage:{input_tokens:tokens,input_tokens_details:{cached_tokens:0},output_tokens:5}}),{headers:{'content-type':'application/json','x-request-id':`mock-${index}`}});
      }});
      const budget=new CarriedCalibrationBudget(.1328787,.03),root=new Evidence(p);
      const result=await completeCalibration(api,root,parent,budget,[]);
      expect(calls).toBe(6);expect(result.pass).toBe(true);expect(result.rule).toEqual(FIXED_RULE);
      expect(result.fixtures).toHaveLength(3);expect(budget.snapshot().historicalUnresolvedReservationUsd).toBe(.03);
    } finally {output.mockRestore();cleanup(p);}
  });
  it('stops on a changed bridge without dispatching the remaining requests',async()=>{
    const p=mkdtempSync(join(tmpdir(),'tracer-observation-continuation-'));const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    try {
      let calls=0;const api=new OpenAI({apiKey:'mock',maxRetries:0,fetch:async()=>{calls++;return new Response(JSON.stringify({object:'response',model:'gpt-5.6-luna',status:'completed',output:[],usage:{input_tokens:5000,input_tokens_details:{cached_tokens:0},output_tokens:5}}),{headers:{'content-type':'application/json'}});}});
      await expect(completeCalibration(api,new Evidence(p),parent,new CarriedCalibrationBudget(.1328787,.03),[])).rejects.toThrow('BRIDGE_FAILED');
      expect(calls).toBe(1);
    }finally{output.mockRestore();cleanup(p);}
  });
});
