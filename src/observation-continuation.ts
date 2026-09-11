import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type OpenAI from 'openai';
import type {Response as ModelResponse,ResponseCreateParamsNonStreaming,ResponseInputItem} from 'openai/resources/responses/responses';
import {Evidence} from './evidence.js';
import {DEFAULT_MODEL,SDK_VERSION,sha256} from './protocol.js';
import {ACK,ARMS,OBS_INSTRUCTIONS,factText,recallQuery,scoreRecall,calibrationPass,type Fact,type Rule,type Sample,type Arm} from './observation.js';
import {replayObservation} from './observation-replay.js';

const read=<T=any>(path:string):T=>JSON.parse(readFileSync(path,'utf8'));
export const CONTINUATION_PROTOCOL='context-observation-v10';
export const FIXED_RULE:Rule={fraction:.5,absolute:2048,confirmations:2};
export function continuationRegistration() {
  const r=read('evidence/preregistration-v10.json');
  const checks=[[r.protocolHash,'research/18-observation-continuation-protocol.md'],[r.parentResultHash,join(r.parent,'result.json')],
    [r.parentLockHash,join(r.parent,'detector-lock.json')],[r.fixtureHash,join(r.parent,'heldout-2/fixture.json')],
    [r.detectorSourceHash,'src/observation.ts']];
  if(r.protocol!==CONTINUATION_PROTOCOL || r.model!==DEFAULT_MODEL || r.sdk!==SDK_VERSION || checks.some(([hash,path])=>hash!==sha256(readFileSync(path)))) throw new Error('CONTINUATION_REGISTRATION_CHANGED');
  if(JSON.stringify(read(join(r.parent,'detector-lock.json')).rule)!==JSON.stringify(FIXED_RULE)) throw new Error('DETECTOR_CHANGED');
  const parent=read(join(r.parent,'result.json')).calibrationBudget;
  if(Math.abs(parent.estimateUsd-r.carriedKnownUsd)>1e-10 || parent.unknownRequests!==1 ||
    Math.abs(parent.admissionEstimateUsd-r.carriedKnownUsd-r.carriedUnresolvedUsd)>1e-10) throw new Error('PARENT_BUDGET_CHANGED');
  return r;
}
type Counts={input_tokens:number;output_tokens:number};
export class CarriedCalibrationBudget {
  readonly calls:{name:string;usage:Counts|null;estimateUsd:number|null}[]=[];
  constructor(readonly knownUsd:number,readonly unresolvedUsd:number) {
    if(![knownUsd,unresolvedUsd].every(n=>Number.isFinite(n)&&n>=0)) throw new Error('INVALID_CARRY');
  }
  reserve(name:string) {
    if(this.calls.some(c=>!c.usage)) throw new Error('NEW_REQUEST_UNSETTLED');
    if(this.calls.length>=6) throw new Error('CONTINUATION_REQUEST_CAP');
    if(this.snapshot().admissionEstimateUsd+.03>.5) throw new Error('CALIBRATION_ADMISSION_CAP');
    this.calls.push({name,usage:null,estimateUsd:null});
  }
  settle(usage:Counts|null|undefined) {
    const last=this.calls.at(-1);
    if(!last || last.usage) throw new Error('INVALID_SETTLEMENT');
    if(!usage || ![usage.input_tokens,usage.output_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error('MISSING_USAGE');
    last.usage={input_tokens:usage.input_tokens,output_tokens:usage.output_tokens};
    last.estimateUsd=(usage.input_tokens*.5+usage.output_tokens*1.8)/1e6;
    if(this.snapshot().admissionEstimateUsd>=.5) throw new Error('CALIBRATION_SPEND_THRESHOLD');
  }
  snapshot() {
    const newKnownUsd=this.calls.reduce((n,c)=>n+(c.estimateUsd??0),0),newUnknown=this.calls.filter(c=>!c.usage).length;
    return {knownEstimateUsd:this.knownUsd+newKnownUsd,priorKnownUsd:this.knownUsd,historicalUnresolvedReservationUsd:this.unresolvedUsd,
      admissionEstimateUsd:this.knownUsd+this.unresolvedUsd+newKnownUsd+newUnknown*.03,newUnknownRequests:newUnknown,newKnownUsd,calls:this.calls};
  }
}
export interface CalibrationRequest {name:string;body:ResponseCreateParamsNonStreaming;kind:'ack'|'recall'}
export function missingCalibrationRequests(parent:string):CalibrationRequest[] {
  const folder=join(parent,'heldout-2'),fixture=read(join(folder,'fixture.json'));
  const facts:Fact[]=[fixture.facts[0],fixture.facts[3],fixture.facts[6],fixture.facts[7],fixture.recent];
  const requests:CalibrationRequest[]=[{name:'bridge',kind:'ack',body:read(join(folder,'pre-2-request.json'))},
    {name:'prefix-recall',kind:'recall',body:read(join(folder,'prefix-recall-request.json'))}];
  let history:ResponseInputItem[]=fixture.exchanges.slice(-2).flat();
  const body=(query:string,kind:'ack'|'recall'):ResponseCreateParamsNonStreaming=>({model:DEFAULT_MODEL,instructions:OBS_INSTRUCTIONS,
    input:[...history,{role:'user',content:query}],service_tier:'default',store:false,stream:false,background:false,reasoning:{effort:'low'},
    include:['reasoning.encrypted_content'],tools:[],tool_choice:'none',parallel_tool_calls:false,max_output_tokens:kind==='recall'?768:256});
  for(let i=0;i<3;i++) {
    if(i>0) history=[...history.slice(2),{role:'user',content:`Clock tick ${i}.${i===2?'\n'+factText(fixture.recent):''}`},{role:'assistant',content:'ACK'}];
    requests.push({name:`rolling-post-${i+1}`,kind:'ack',body:body(ACK,'ack')});
  }
  requests.push({name:'rolling-recall',kind:'recall',body:body(recallQuery(facts),'recall')});
  return requests;
}
export function responseSample(id:string,response:ModelResponse,at:string):Sample {
  const reasons:string[]=[];
  if(response.status!=='completed') reasons.push('INCOMPLETE_RESPONSE');
  if(response.output_text?.trim()!=='ACK') reasons.push('NOT_ACK');
  if(!Array.isArray(response.output) || response.output.some(o=>!['message','reasoning'].includes(o.type))) reasons.push('UNEXPECTED_OUTPUT');
  if(!response.usage) reasons.push('MISSING_USAGE');
  return {id,at,input:response.usage?.input_tokens??null,cached:response.usage?.input_tokens_details.cached_tokens??null,
    output:response.usage?.output_tokens??null,valid:reasons.length===0,reasons};
}
export function bridgePass(sample:Sample,originalInput:number) {
  return sample.valid && sample.input!==null && Math.abs(sample.input-originalInput)<=Math.max(128,originalInput*.01);
}
export function joinedCalibration(parent:string,continuation:string) {
  const old=join(parent,'heldout-2'),fresh=join(continuation,'calibration-continuation'),fixture=read(join(old,'fixture.json'));
  const sourceHashes:{path:string;sha256:string}[]=[];
  const load=(name:string):{data:ModelResponse;at:string}=>{
    const from=existsSync(join(fresh,`${name}-response.json`))?fresh:old,path=join(from,`${name}-response.json`);
    if(!existsSync(path)) throw new Error('CALIBRATION_INCOMPLETE');
    const data=read<ModelResponse>(path);sourceHashes.push({path,sha256:sha256(readFileSync(path))});
    const events=readFileSync(join(from,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
    const event=events.find(e=>e.kind==='request.completed'&&e.data.name===name);
    if(!event) throw new Error('RESPONSE_EVENT_MISSING');
    return {data,at:event.at};
  };
  const bridge=load('bridge'),oldInput=read<ModelResponse>(join(old,'pre-2-response.json')).usage!.input_tokens;
  const bridgeSample=responseSample('bridge',bridge.data,bridge.at);
  const trajectories={} as Record<Arm,Sample[]>,recall={} as Record<Arm,ReturnType<typeof scoreRecall>>;
  for(const arm of ARMS) {
    trajectories[arm]=['pre-1','pre-2',`${arm}-post-1`,`${arm}-post-2`,`${arm}-post-3`].map(name=>{const r=load(name);return responseSample(name,r.data,r.at);});
    const r=load(`${arm}-recall`);
    recall[arm]=scoreRecall(r.data.output_text,[fixture.facts[0],fixture.facts[3],fixture.facts[6],fixture.facts[7],fixture.recent]);
  }
  const completed={id:'heldout-2',trajectories,recall,pass:calibrationPass(trajectories,FIXED_RULE)};
  const fixtures=[read(join(parent,'development/result.json')),read(join(parent,'heldout-1/result.json')),completed];
  return {pass:bridgePass(bridgeSample,oldInput)&&fixtures.every(f=>ARMS.every(a=>f.trajectories[a].length===5)&&calibrationPass(f.trajectories,FIXED_RULE)),
    rule:FIXED_RULE,bridge:{sample:bridgeSample,originalInput:oldInput,pass:bridgePass(bridgeSample,oldInput)},fixtures,sourceHashes};
}
export async function completeCalibration(client:OpenAI,root:Evidence,parent:string,budget:CarriedCalibrationBudget,secrets:string[]) {
  const log=new Evidence(join(root.directory,'calibration-continuation'),secrets),plan=missingCalibrationRequests(parent);
  log.write('plan.json',{parent,requests:plan.map(r=>({name:r.name,kind:r.kind,bodyHash:sha256(JSON.stringify(r.body))})),rule:FIXED_RULE});
  for(const request of plan) {
    log.write(`${request.name}-request.json`,request.body);budget.reserve(request.name);
    root.record('continuation.reserved',{name:request.name,budget:budget.snapshot()});
    console.log(JSON.stringify({event:'calibration-continuation-request',name:request.name,accountingUsd:budget.snapshot().admissionEstimateUsd}));
    const {data,response}=await client.responses.create(request.body).withResponse();
    log.write(`${request.name}-response.json`,data);
    log.record('request.completed',{name:request.name,requestId:response.headers.get('x-request-id'),usage:data.usage,outputHash:sha256(JSON.stringify(data.output))});
    budget.settle(data.usage);
    if(data.model!==DEFAULT_MODEL) throw new Error('MODEL_CHANGED');
    if(request.name==='bridge' && !bridgePass(responseSample('bridge',data,new Date().toISOString()),read(join(parent,'heldout-2/pre-2-response.json')).usage.input_tokens)) throw new Error('BRIDGE_FAILED');
  }
  const result=joinedCalibration(parent,root.directory);root.write('calibration.json',result);return result;
}
export function claimContinuation(directory:string,run:string,parent:string) {
  writeFileSync(join(directory,'dispatch-observation-v10.json'),JSON.stringify({protocol:CONTINUATION_PROTOCOL,parent,run,startedAt:new Date().toISOString(),
    totalThresholdUsd:2,newAllowance:false,carriedKnownUsd:.1328787,carriedUnresolvedReservationUsd:.03,automaticRetryAllowed:false})+'\n',{flag:'wx'});
}
export function verifyParent(parent:string) {
  const replay=replayObservation(parent);
  if(replay.sourceMatches.some((s:{recordedCommitMatches:boolean})=>!s.recordedCommitMatches) || replay.calibration.paidResponses!==52) throw new Error('PARENT_EVIDENCE_CHANGED');
  return replay;
}
