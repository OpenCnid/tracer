import {afterEach, describe, expect, it, vi} from 'vitest';
import OpenAI from 'openai';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {CompactedResponse,ResponseInputItem} from 'openai/resources/responses/responses';
import {Evidence,verifyLog} from '../src/evidence.js';
import {DEFAULT_MODEL} from '../src/protocol.js';
import {CompactBudget,compactFetch} from '../src/compact-budget.js';
import {claimCompactStudy,classifyCompact,compactBoundary,continuation,visibleHandlePaths,type CompactArmResult} from '../src/compact-protocol.js';
import {runCompactStudy} from '../src/compact-probe.js';

const dirs:string[]=[];
const fresh=()=>{const d=mkdtempSync(join(tmpdir(),'tracer-compact-'));dirs.push(d);return d;};
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0)) {
  if(!resolve(d).startsWith(resolve(tmpdir())+'\\tracer-compact-') && !resolve(d).startsWith(resolve(tmpdir())+'/tracer-compact-')) throw new Error('UNSAFE_TEST_CLEANUP');
  rmSync(d,{recursive:true,force:true});
}});
const good:CompactArmResult={readStatus:'valid',stateIntact:true,submissionCorrect:true};
const compacted=(visible=false)=>({id:'compact-1',object:'response.compaction',created_at:1,
  output:[{type:'message',role:'user',content:visible?'keep state_SECRET':'original task'},
    {type:'compaction',id:'cmp-1',encrypted_content:'opaque state_SECRET'}],
  usage:{input_tokens:100,output_tokens:20}} as unknown as CompactedResponse);

describe('Responses compaction evidence',()=>{
  it('distinguishes service compaction, retained plaintext, and opaque content',()=>{
    expect(compactBoundary(compacted(),'state_SECRET')).toMatchObject({established:true,visibleHandlePaths:[]});
    expect(compactBoundary(compacted(true),'state_SECRET').visibleHandlePaths).toEqual(['$[0].content']);
    const missing=compacted();missing.output=missing.output.filter(i=>i.type!=='compaction');
    expect(compactBoundary(missing,'state_SECRET').established).toBe(false);
    expect(visibleHandlePaths({arguments:'{"handle":"state_SECRET"}'},'state_SECRET')).toEqual(['$.arguments']);
  });
  it('retains the complete canonical output without mutation or additional prior history',()=>{
    const output=compacted(true).output as ResponseInputItem[];
    const before=JSON.stringify(output);const input=continuation(output,'new lookup');
    expect(JSON.stringify(input.slice(0,-1))).toBe(before);expect(JSON.stringify(output)).toBe(before);
    expect(input.length).toBe(output.length+1);expect(input[0]).toBe(output[0]);
  });
  it('separates locator recovery from copying errors and requires a working control',()=>{
    const boundary={established:true,visibleHandlePaths:[]};
    expect(classifyCompact(good,{...good,submissionCorrect:false},boundary,true).outcome).toBe('supported-for-fixture');
    expect(classifyCompact(good,{...good,readStatus:'invalid-handle'},boundary,true).outcome).toBe('refuted-for-tested-workflow');
    expect(classifyCompact({...good,readStatus:'missing-handle'},good,boundary,true).reason).toBe('PAIRED_CONTROL_FAILED');
    expect(classifyCompact(good,good,{...boundary,visibleHandlePaths:['$.message']},true).reason).toBe('VISIBLE_HANDLE_RETAINED');
    expect(classifyCompact(good,good,boundary,false).outcome).toBe('inconclusive');
    expect(classifyCompact(good,{...good,stateIntact:false},boundary,true).outcome).toBe('inconclusive');
    expect(classifyCompact(good,good,{...boundary,established:false},true).outcome).toBe('inconclusive');
  });
});
describe('study allowance',()=>{
  it('keeps unknown usage reserved and refuses more paid work',()=>{
    const budget=new CompactBudget();budget.reserve('compact',true);
    expect(()=>budget.settle(null)).toThrow('MISSING_OR_INVALID_USAGE');
    expect(budget.snapshot()).toMatchObject({admissionEstimateUsd:0.3,unknownUsageRequests:1});
    expect(()=>budget.reserve('next',false)).toThrow('UNSETTLED_REQUEST');
  });
  it('refuses admission near the threshold and stops on reported overshoot',()=>{
    const budget=new CompactBudget();budget.reserve('compact',true);budget.settle({input_tokens:3_600_000,output_tokens:0});
    expect(()=>budget.reserve('another-compact',true)).toThrow('STUDY_ADMISSION_CAP');
    budget.reserve('ordinary',false);
    expect(()=>budget.settle({input_tokens:500_000,output_tokens:0})).toThrow('STUDY_SPEND_THRESHOLD');
    expect(budget.snapshot().estimateUsd).toBeCloseTo(2.05);
  });
  it('bounds request count and makes the dispatch claim exclusive',()=>{
    const budget=new CompactBudget();for(let i=0;i<21;i++){budget.reserve(String(i),false);budget.settle({input_tokens:0,output_tokens:0});}
    expect(()=>budget.reserve('extra',false)).toThrow('REQUEST_CAP');
    const dir=fresh();claimCompactStudy(dir,'first');expect(()=>claimCompactStudy(dir,'second')).toThrow();
    expect(JSON.parse(readFileSync(join(dir,'dispatch-responses-v7.json'),'utf8')).run).toBe('first');
  });
});
describe('official SDK paired transport',()=>{
  it('uses compact output exclusively for treatment and separates all branch tool results',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const dir=fresh();let handle='';let n=0;const requests:{path:string;body:any}[]=[];
    const canonical=[{role:'user',content:'retained original request'},{type:'compaction',id:'cmp-live',encrypted_content:'opaque'}];
    const mock=vi.fn<typeof fetch>(async(input,init)=>{
      const path=new URL(String(input)).pathname;const body=JSON.parse(String(init?.body));requests.push({path,body});
      const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json','x-request-id':`req-${n}`}});
      const output=(items:unknown[],text='')=>json({id:`resp-${++n}`,object:'response',status:'completed',model:DEFAULT_MODEL,
        output:items,output_text:text,usage:{input_tokens:100,output_tokens:20}});
      const call=(name:string,args:unknown)=>output([{type:'function_call',id:`fc-${n}`,call_id:`call-${n}`,name,arguments:JSON.stringify(args),status:'completed'}]);
      if(path.endsWith('/compact')) return json({id:'cmp-response',object:'response.compaction',created_at:1,output:canonical,usage:{input_tokens:100,output_tokens:20}});
      expect(body.store).toBe(false);expect(body.previous_response_id).toBeUndefined();expect(body.conversation).toBeUndefined();
      const name=body.tools[0]?.name;
      if(name==='tracer_manifest') return call(name,{});
      if(!name) {handle=JSON.parse(body.input.find((i:any)=>i.type==='function_call_output').output).handle;return output([{type:'message',role:'assistant',id:'ready',status:'completed',content:[{type:'output_text',text:'Ready.',annotations:[]}]}],'Ready.');}
      if(name==='tracer_state_read') {
        const query=body.input.at(-1).content;const indices=JSON.parse(query.match(/indices (\[[\d,]+\])/)[1]);
        return call(name,{handle,indices});
      }
      return call(name,JSON.parse(body.input.at(-1).output));
    });
    const client=new OpenAI({apiKey:'mock',maxRetries:0,fetch:compactFetch(mock)});
    const result=await runCompactStudy(client,new Evidence(dir),new CompactBudget(),1);
    expect(result.error).toBeNull();expect(requests).toHaveLength(7);
    expect(requests[5]!.body.input.slice(0,-1)).toEqual(canonical);
    expect(JSON.stringify(requests[5]!.body.input)).not.toContain(handle);
    expect(requests[3]!.body.input.some((i:any)=>i.type==='function_call_output')).toBe(true);
    expect((result.summaries[0] as any).classification.outcome).toBe('supported-for-fixture');
    expect(verifyLog(join(dir,'events.jsonl'))).toBeGreaterThan(0);
  });
  it('stops on an unsupported compact call without retries or replacement trials',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const dir=fresh();let calls=0;
    const mock=vi.fn<typeof fetch>(async(input)=>{
      calls++;const compact=String(input).includes('/compact');
      if(compact)return new Response(JSON.stringify({error:{message:'Unsupported compact model',type:'invalid_request_error',code:'unsupported_model'}}),{status:400,headers:{'content-type':'application/json'}});
      const output=calls===1?[{type:'function_call',call_id:'m1',id:'f1',name:'tracer_manifest',arguments:'{}',status:'completed'}]:[];
      return new Response(JSON.stringify({id:`r-${calls}`,status:'completed',model:DEFAULT_MODEL,output,output_text:'Ready.',usage:{input_tokens:10,output_tokens:5}}),{headers:{'content-type':'application/json'}});
    });
    const result=await runCompactStudy(new OpenAI({apiKey:'mock',fetch:mock,maxRetries:0}),new Evidence(dir),new CompactBudget());
    expect(calls).toBe(3);expect(result.outcome).toBe('inconclusive');expect(result.budget.unknownUsageRequests).toBe(1);
    expect(result.error).toMatchObject({status:400});
  });
});
