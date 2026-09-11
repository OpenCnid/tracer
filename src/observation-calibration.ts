import type OpenAI from 'openai';
import type {Response as ModelResponse, CompactedResponse, ResponseInputItem, ResponseCreateParamsNonStreaming} from 'openai/resources/responses/responses';
import {join} from 'node:path';
import {Evidence} from './evidence.js';
import {DEFAULT_MODEL,sha256} from './protocol.js';
import {ACK,ARMS,OBS_INSTRUCTIONS,calibrationFixture,fact,factText,recallQuery,scoreRecall,chooseRule,calibrationPass,detect,
  type Arm,type Sample,type Rule,ObservationBudget} from './observation.js';

export async function calibrate(client:OpenAI,root:Evidence,budget:ObservationBudget,secrets:string[]) {
  let rule:Rule|null=null;
  const fixtures: {id:string;trajectories:Record<Arm,Sample[]>;recall:Record<Arm,ReturnType<typeof scoreRecall>>;pass:boolean}[]=[];
  for(let f=0;f<3;f++) {
    const id=f===0?'development':`heldout-${f}`,log=new Evidence(join(root.directory,id),secrets);
    const fixture={...calibrationFixture(),recent:fact('latestTick')};log.write('fixture.json',fixture);
    async function paid(name:string,input:ResponseInputItem[],kind:'ack'|'recall'|'compact') {
      const base={model:DEFAULT_MODEL,instructions:OBS_INSTRUCTIONS,input,service_tier:'default' as const};
      const body:ResponseCreateParamsNonStreaming={...base,store:false,stream:false,background:false,reasoning:{effort:'low'},
        include:['reasoning.encrypted_content'],tools:[],tool_choice:'none',parallel_tool_calls:false,max_output_tokens:kind==='recall'?768:256};
      log.write(`${name}-request.json`,kind==='compact'?base:body);
      budget.reserve(`${id}/${name}`,kind==='compact');root.record('calibration.reserved',{id,name,budget:budget.snapshot()});
      const {data,response}=kind==='compact'?await client.responses.compact(base).withResponse():await client.responses.create(body).withResponse();
      log.write(`${name}-response.json`,data);
      log.record('request.completed',{name,at:new Date().toISOString(),requestId:response.headers.get('x-request-id'),usage:data.usage,outputHash:sha256(JSON.stringify(data.output))});
      budget.settle(data.usage);
      if('model' in data && data.model!==DEFAULT_MODEL) throw new Error('UNEXPECTED_RETURNED_MODEL');
      return data;
    }
    async function ack(name:string,history:ResponseInputItem[]):Promise<Sample> {
      const data=await paid(name,[...history,{role:'user',content:ACK}],'ack') as ModelResponse;
      const reasons:string[]=[];
      if(data.status!=='completed') reasons.push('INCOMPLETE_RESPONSE');
      if(data.output_text.trim()!=='ACK') reasons.push('NOT_ACK');
      if(data.output.some(o=>!['reasoning','message'].includes(o.type))) reasons.push('UNEXPECTED_OUTPUT');
      if(!data.usage) reasons.push('MISSING_USAGE');
      return {id:name,at:new Date().toISOString(),input:data.usage?.input_tokens??null,cached:data.usage?.input_tokens_details.cached_tokens??null,
        output:data.usage?.output_tokens??null,valid:reasons.length===0,reasons};
    }
    const pre=[await ack('pre-1',fixture.history),await ack('pre-2',fixture.history)];
    const compact=await paid('compact',fixture.history,'compact') as CompactedResponse;
    const marker=compact.object==='response.compaction' && compact.output.some(i=>i.type==='compaction' && !!i.encrypted_content);
    log.write('boundary.json',{knownIntervention:true,marker,canonicalHash:sha256(JSON.stringify(compact.output))});
    if(!marker) throw new Error('COMPACTION_MARKER_MISSING');
    const trajectories={} as Record<Arm,Sample[]>,recall={} as Record<Arm,ReturnType<typeof scoreRecall>>;
    for(const arm of ARMS) {
      let history:ResponseInputItem[]=arm==='compact'?compact.output as ResponseInputItem[]:
        arm==='full'?fixture.history:fixture.exchanges.slice(-2).flat();
      trajectories[arm]=[...pre];
      for(let i=0;i<3;i++) {
        if(i>0) {
          if(arm==='rolling') history=history.slice(2);
          history=[...history,{role:'user',content:`Clock tick ${i}.${i===2?'\n'+factText(fixture.recent):''}`},{role:'assistant',content:'ACK'}];
        }
        if(arm==='compact' && JSON.stringify(history.slice(0,compact.output.length))!==JSON.stringify(compact.output)) throw new Error('CANONICAL_PREFIX_CHANGED');
        trajectories[arm].push(await ack(`${arm}-post-${i+1}`,history));
      }
      const facts=[fixture.facts[0]!,fixture.facts[3]!,fixture.facts[6]!,fixture.facts[7]!,fixture.recent];
      const answer=await paid(`${arm}-recall`,[...history,{role:'user',content:recallQuery(facts)}],'recall') as ModelResponse;
      recall[arm]=scoreRecall(answer.output_text,facts);
      log.write(`${arm}-recall-score.json`,{...recall[arm],completed:answer.status==='completed',
        recentControlsStructurallyPresent:true,latestControl:'latestTick',notUsedForDetector:true});
    }
    if(f===0) {
      rule=chooseRule(trajectories);
      root.write('detector-lock.json',{rule,lockedAt:new Date().toISOString(),development:id,heldoutRequestsSoFar:0,
        specificity:'context reduction only; deletion is deliberately required to trigger'});
    }
    const pass=rule!==null && calibrationPass(trajectories,rule);
    const result={id,trajectories,recall,pass};fixtures.push(result);
    log.write('result.json',{...result,rule,candidates:rule?Object.fromEntries(ARMS.map(a=>[a,detect(trajectories[a],rule!)])):null});
    root.record('calibration.fixture',result);
    console.log(JSON.stringify({event:'calibration-fixture',id,pass,rule,estimateUsd:budget.snapshot().estimateUsd}));
    if(!pass) break;
  }
  const result={pass:fixtures.length===3 && fixtures.every(f=>f.pass),rule,fixtures,scope:'context reduction; not compaction identification'};
  root.write('calibration.json',result);return result;
}
