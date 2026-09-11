import {randomBytes, randomInt} from 'node:crypto';
import type {ResponseInputItem} from 'openai/resources/responses/responses';
import {GUARD_RATES} from './budget.js';

export const OBS_PROTOCOL='context-observation-v9';
export const ACK='Reply with exactly ACK. Do not call any tools or repeat earlier information.';
export const OBS_INSTRUCTIONS='Follow the current user request. Preserve important arbitrary task mappings for later questions; log noise is irrelevant. On measurement turns return exactly ACK without tools or additional text. On recall turns return only the requested JSON object, using null for unavailable answers; do not guess.';
export interface Sample {id:string; at:string; input:number|null; cached:number|null; output:number|null; valid:boolean; reasons:string[]}
export interface Rule {fraction:number; absolute:number; confirmations:2}
export interface Candidate {before:string; drop:string; confirmed:string; beforeInput:number; ceiling:number; interval:[string,string]}
export function drop(before:Sample,next:Sample,rule:Rule) {
  return before.valid && next.valid && before.input!==null && next.input!==null &&
    before.input-next.input>=rule.absolute && next.input<=before.input*(1-rule.fraction);
}
export function detect(samples:Sample[],rule:Rule):Candidate|null {
  for(let i=1;i<samples.length;i++) {
    const before=samples[i-1]!,first=samples[i]!;
    if(!drop(before,first,rule)) continue;
    // Do not search for a later candidate after the first eligible drop fails persistence.
    const next=samples.slice(i+1,i+3),ceiling=Math.min(before.input!*(1-rule.fraction),before.input!-rule.absolute);
    if(next.length!==2 || next.some(s=>!s.valid || s.input===null || s.input>ceiling)) return null;
    return {before:before.id,drop:first.id,confirmed:next[1]!.id,beforeInput:before.input!,ceiling,interval:[before.at,next[1]!.at]};
  }
  return null;
}
export type Arm='full'|'compact'|'prefix'|'rolling';
export const ARMS:Arm[]=['full','compact','prefix','rolling'];
export function chooseRule(trajectories:Record<Arm,Sample[]>):Rule|null {
  for(const fraction of [.75,.5,.25]) for(const absolute of [2048,1024]) {
    const rule:Rule={fraction,absolute,confirmations:2};
    if(detect(trajectories.compact,rule) && detect(trajectories.prefix,rule) && !detect(trajectories.full,rule)) return rule;
  }
  return null;
}
export function calibrationPass(trajectories:Record<Arm,Sample[]>,rule:Rule) {
  return ARMS.every(a=>trajectories[a].every(s=>s.valid)) &&
    !!detect(trajectories.compact,rule) && !!detect(trajectories.prefix,rule) && !detect(trajectories.full,rule);
}
export interface Fact {id:string; task:string; code:string; taskFirst:boolean}
export function fact(id:string):Fact {return {id,task:randomBytes(6).toString('hex'),code:randomBytes(6).toString('hex'),taskFirst:!!randomInt(2)};}
export function factText(f:Fact) {
  const a=`Important task mapping: ${f.id}.task = ${f.task}. Retain its exact value for future work.`;
  const b=`Irrelevant log code: ${f.id}.code = ${f.code}.`;
  return f.taskFirst?`${a}\n${b}`:`${b}\n${a}`;
}
export function calibrationFixture() {
  const facts=Array.from({length:8},(_,i)=>fact(`entry${i+1}`));
  const exchanges:ResponseInputItem[][]=facts.map(f=>[
    {role:'user',content:`Record entry ${f.id}. Its task mapping matters; the log text does not.`},
    {role:'assistant',content:`${factText(f)}\nIrrelevant log: ${randomBytes(1024).toString('hex')}`},
  ]);
  return {facts,exchanges,history:exchanges.flat()};
}
export function recallQuery(facts:Fact[]) {
  return `Recall: return one JSON object with these keys and their exact earlier string values (null when unavailable): ${facts.flatMap(f=>[`${f.id}.task`,`${f.id}.code`]).join(', ')}. Use no tools and no markdown.`;
}
export function scoreRecall(text:string,facts:Fact[]) {
  let answer:Record<string,unknown>|null=null;
  try {const parsed=JSON.parse(text);if(parsed && typeof parsed==='object' && !Array.isArray(parsed)) answer=parsed;}catch{/* Raw output is retained. */}
  return {validJSON:answer!==null,items:facts.map(f=>({id:f.id,task:answer?.[`${f.id}.task`]===f.task,code:answer?.[`${f.id}.code`]===f.code})),answer};
}
type Counts={input_tokens:number;output_tokens:number};
export class ObservationBudget {
  readonly calls:{name:string;reserve:number;usage:Counts|null;estimate:number|null}[]=[];
  reserve(name:string,compact:boolean) {
    if(this.calls.some(c=>!c.usage)) throw new Error('UNSETTLED_REQUEST');
    if(this.calls.length>=57) throw new Error('CALIBRATION_REQUEST_CAP');
    const reserve=compact?.10:.03;
    if(this.snapshot().admissionEstimateUsd+reserve>.5) throw new Error('CALIBRATION_ADMISSION_CAP');
    this.calls.push({name,reserve,usage:null,estimate:null});
  }
  settle(usage:Counts|null|undefined) {
    const last=this.calls.at(-1);
    if(!last || last.usage) throw new Error('INVALID_SETTLEMENT');
    if(!usage || ![usage.input_tokens,usage.output_tokens].every(v=>Number.isSafeInteger(v)&&v>=0)) throw new Error('MISSING_USAGE');
    last.usage={input_tokens:usage.input_tokens,output_tokens:usage.output_tokens};
    last.estimate=(usage.input_tokens*GUARD_RATES.inputPerMillionUsd+usage.output_tokens*GUARD_RATES.outputPerMillionUsd)/1e6;
    if(this.snapshot().admissionEstimateUsd>=.5) throw new Error('CALIBRATION_SPEND_THRESHOLD');
  }
  snapshot() {return {estimateUsd:this.calls.reduce((s,c)=>s+(c.estimate??0),0),admissionEstimateUsd:this.calls.reduce((s,c)=>s+(c.estimate??c.reserve),0),unknownRequests:this.calls.filter(c=>!c.usage).length,calls:this.calls,rates:GUARD_RATES};}
}
export function studyFetch(base:typeof fetch) {
  let requests=0;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    const method=init?.method??(input instanceof Request?input.method:'GET');
    const cleanup=method==='GET' || (method==='POST' && /\/events$/.test(url.pathname) && init?.body==='{"events":[{"type":"agent.session.input.cancel"}]}');
    if(++requests>(cleanup?3000:2970)) throw new Error('STUDY_HTTP_CAP');
    if(typeof init?.body==='string' && Buffer.byteLength(init.body)>2*1024*1024) throw new Error('REQUEST_BODY_CAP');
    return base(input,init);
  };
  return {fetch:fetcher,count:()=>requests};
}
