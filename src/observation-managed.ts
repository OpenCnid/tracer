import OpenAI from 'openai';
import {randomBytes,randomInt} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,constants} from 'node:fs';
import {join,relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Turn} from 'openai/resources/beta/agents/sessions/turns';
import type {AgentSession,AgentSessionItem} from 'openai/resources/beta/agents/agents';
import {Evidence} from './evidence.js';
import {UsageGuard,boundedFetch} from './budget.js';
import {DEFAULT_MODEL,sha256,type Trial} from './protocol.js';
import {collectTrial,type CollectionOptions} from './collector.js';
import {checkpointRequest} from './checkpoint-protocol.js';
import {CheckpointStore,SessionBindings,type TaskReference} from './checkpoint-store.js';
import {CheckpointLedger} from './checkpoint-ledger.js';
import {ACK,OBS_INSTRUCTIONS,OBS_PROTOCOL,drop,detect,fact,factText,recallQuery,scoreRecall,type Fact,type Sample,type Rule} from './observation.js';
import type {StateRecord} from './state-store.js';

type Action=Extract<AgentSession['required_actions'][number],{type:'function_call'}>;
const read=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8'));
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value)+'\n',{flag:'wx'});
export class ObservationBindings extends SessionBindings {
  freeze(sessionId:string,reference:TaskReference) {
    const original=super.lookup(sessionId);
    if(!original || original.reference.taskHash!==reference.taskHash || original.reference.sourceHash!==reference.sourceHash) throw new Error('BINDING_CHANGED');
    new CheckpointStore(reference).verify();
    save(join(this.directory,`${sha256(sessionId)}-frozen.json`),{sessionId,reference});
  }
  override lookup(sessionId:string) {
    const original=super.lookup(sessionId),path=join(this.directory,`${sha256(sessionId)}-frozen.json`);
    if(!existsSync(path)) return original;
    const frozen=read<{sessionId:string;reference:TaskReference}>(path);
    if(frozen.sessionId!==sessionId || !original || frozen.reference.taskHash!==original.reference.taskHash ||
      frozen.reference.sourceHash!==original.reference.sourceHash) throw new Error('BINDING_CHANGED');
    return new CheckpointStore(frozen.reference);
  }
}
export class RecordLedger {
  readonly saved=new Map<string,{args:string;output:string}>();
  reports:boolean[]=[];
  correct:boolean|null=null;
  constructor(readonly base:CheckpointLedger,readonly indices:number[],readonly log:Evidence) {}
  handle(sessionId:string,action:Action) {
    if(!['tracer_state_read','tracer_state_submit'].includes(action.name)) return this.base.handle(sessionId,action);
    const key=`${sessionId}:${action.turn_id}:${action.call_id}`,args=JSON.stringify(action.arguments);
    const old=this.saved.get(key);
    if(old) {if(old.args!==`${action.name}:${args}`) throw new Error('CHANGED_DUPLICATE_CALL');return old.output;}
    if(this.saved.size>=4 || [...this.saved.values()].reduce((n,s)=>n+Buffer.byteLength(s.output),0)+6144>24576) throw new Error('RECORD_TOOL_CAP');
    const store=this.base.bindings.lookup(sessionId);if(!store) throw new Error('BINDING_MISSING');store.verify();
    const source=read<{records:StateRecord[]}>(join(store.reference.directory,'external-state.json'));
    const expected=this.indices.map(i=>source.records[i]!);
    const input=action.arguments as Record<string,unknown>;
    let value:unknown={status:'rejected',reason:'INVALID_ARGUMENTS'};
    if(input && typeof input==='object' && !Array.isArray(input)) {
      if(action.name==='tracer_state_read' && Object.keys(input).sort().join(',')==='handle,indices' && input.handle===store.task.handle && JSON.stringify(input.indices)===JSON.stringify(this.indices)) value={records:expected};
      if(action.name==='tracer_state_submit') {
        const rows=input.records;
        this.correct=Object.keys(input).join(',')==='records' && Array.isArray(rows) && rows.length===2 && expected.every(w=>rows.filter(r=>r && Object.keys(r).sort().join(',')==='index,value' && r.index===w.index && r.value===w.value).length===1);
        this.reports.push(this.correct);value={accepted:this.correct};
      }
    }
    const output=JSON.stringify(value);if(Buffer.byteLength(output)>6144) throw new Error('RECORD_OUTPUT_CAP');
    const record={key,name:action.name,args:`${action.name}:${args}`,input:action.arguments,output};
    save(join(this.log.directory,`record-call-${this.saved.size}.json`),record);
    this.saved.set(key,{args:record.args,output});this.log.record('record.executed',record);return output;
  }
}
function request(trial:Trial) {
  const body=checkpointRequest({...trial,phase:'bound'});
  body.metadata={protocol:OBS_PROTOCOL,trial:trial.id};
  body.input='Setup: discover the assigned task, process ONLY the first pending job, then stop. Leave the other two pending. Do not submit a resume report yet.';
  body.agent!.instructions=OBS_INSTRUCTIONS+' During setup or recovery use application tools to discover assigned state. Never request a completed job again. On recovery, finish pending jobs sequentially and report all original and new results; correct rejected reports within the available tool limits. Retrieve the requested external records and submit their exact values. On ACK and recall turns use no tools, do no task work, and repeat no saved task data. Do not delegate or use external services.';
  body.agent!.tools!.push(
    {type:'function',name:'tracer_state_read',description:'Read exactly two requested external records using the task handle.',parameters:{type:'object',properties:{handle:{type:'string'},indices:{type:'array',items:{type:'integer'},minItems:2,maxItems:2}},required:['handle','indices'],additionalProperties:false}},
    {type:'function',name:'tracer_state_submit',description:'Submit the two exact requested external records. Correct a rejected submission within tool limits.',parameters:{type:'object',properties:{records:{type:'array',minItems:2,maxItems:2,items:{type:'object',properties:{index:{type:'integer'},value:{type:'string'}},required:['index','value'],additionalProperties:false}}},required:['records'],additionalProperties:false}});
  return body;
}
export function ackObservation(id:string,turn:Turn,items:AgentSessionItem[],stable:boolean,complete:boolean):Sample {
  const selected=items.filter(i=>i.turn_id===turn.id),messages=selected.filter(i=>i.type==='message' && i.role==='assistant');
  const text=messages.map(m=>m.type==='message'?m.content.map(c=>'text' in c?c.text:'').join(''):'').join('');
  const reasons:string[]=[];
  if(!complete || turn.status!=='completed') reasons.push('INCOMPLETE_LIFECYCLE');
  if(!stable || !turn.usage) reasons.push('UNSETTLED_USAGE');
  if(messages.length!==1 || text.trim()!=='ACK') reasons.push('NOT_SINGLE_ACK');
  if(selected.some(i=>!['message','reasoning'].includes(i.type))) reasons.push('VISIBLE_NON_MEASUREMENT_WORK');
  return {id,at:new Date((turn.completed_at??turn.created_at)*1000).toISOString(),input:turn.usage?.input_tokens??null,
    cached:turn.usage?.input_tokens_details.cached_tokens??null,output:turn.usage?.output_tokens??null,valid:reasons.length===0,reasons};
}
export interface ManagedCase {id:string;sessionId:string|null;samples:Sample[];candidate:ReturnType<typeof detect>;recovery:unknown;error:string|null}
export interface ManagedRestore {parent:string;session:AgentSession;turns:Turn[];items:AgentSessionItem[];readOnlySource:string;measurementDirectories?:string[];pendingDose?:{fact:Fact;input:string;source:string}}
export class TransportUsageGuard extends UsageGuard {
  transportReservationUsd=0;
  reserveUnestablished() {this.transportReservationUsd+=.2;}
  override snapshot() {
    const s=super.snapshot();return {...s,transportReservationUsd:this.transportReservationUsd,
      priorEstimateUsd:s.priorEstimateUsd+this.transportReservationUsd,admissionEstimateUsd:s.admissionEstimateUsd+this.transportReservationUsd,
      estimateUsd:s.estimateUsd===null?null:s.estimateUsd+this.transportReservationUsd};
  }
}
export function canRetryUnestablished(status:AgentSession,turns:Turn[],seen:Set<string>,more:boolean) {
  return status.status==='idle'&&!status.required_actions.length&&!more&&turns.length===seen.size&&
    turns.every(t=>seen.has(t.id)&&t.status==='completed'&&!!t.usage);
}
export async function managedStudy(root:Evidence,rule:Rule,priorUsd:number,key:string,fetcher:typeof fetch,options:{protocol?:string;restore?:ManagedRestore;settlementPolls?:number;settlementDelayMs?:number;transportRetries?:number}={}) {
  const guard=new TransportUsageGuard(DEFAULT_MODEL,2,.5,priorUsd),cases:ManagedCase[]=[];
  const bindings=new ObservationBindings(join(options.restore?.parent??root.directory,'bindings'));
  let turnsDispatched=options.restore?.turns.length??0;
  const client=()=>new OpenAI({apiKey:key,maxRetries:0,timeout:120000,fetch:boundedFetch(fetcher),...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
  const seenSessions=new Set<string>();
  let transportRetries=0;
  if(options.restore) {
    guard.observeSession(options.restore.session.id,options.restore.session.usage);
    for(const t of options.restore.turns) guard.observeTurn(options.restore.session.id,t);
    guard.requireComplete(options.restore.session.id);seenSessions.add(options.restore.session.id);
  }
  let fatal:string|null=null;
  try {
    for(let pair=1;pair<=3;pair++) for(const arm of ['control','pressure'] as const) {
      const id=`b${pair}-${arm}`,log=new Evidence(join(root.directory,id),[key]);
      const restore=pair===1&&arm==='control'?options.restore:undefined;
      const store=restore?bindings.lookup(restore.session.id)!:CheckpointStore.create(join(log.directory,'state'));
      if(!store) throw new Error('RESTORED_BINDING_MISSING');
      const trial:Trial={id,block:pair,arm:'programmatic-local',seed:sha256(id),model:DEFAULT_MODEL};
      const body=request(trial);if(options.protocol) body.metadata={...body.metadata,protocol:options.protocol};log.write('configuration.json',body);
      const row:ManagedCase={id,sessionId:restore?.session.id??null,samples:[],candidate:null,recovery:null,error:null};cases.push(row);
      const seenTurns=new Set<string>(restore?.turns.map(t=>t.id));
      const facts:Fact[]=[];
      const measurements:{sample:Sample;turnId:string;items:AgentSessionItem[];complete:boolean}[]=[];
      let sequence=restore?.turns.length??0;
      if(restore) {
        const dirs=restore.measurementDirectories??[join(restore.parent,id,'01-baseline-1')];
        for(let index=0;index<dirs.length;index++) {
          const from=dirs[index]!,name=`baseline-${index+1}`,to=join(log.directory,`${String(index+1).padStart(2,'0')}-${name}`);mkdirSync(to,{recursive:true});
          for(const file of ['events.jsonl','request.json','collection.json']) copyFileSync(join(from,file),join(to,file),constants.COPYFILE_EXCL);
          const current=restore.turns[index+1]!,sample=ackObservation(name,current,restore.items,true,true);
          if(!sample.valid) throw new Error('RESTORED_ACK_INVALID');
          save(join(to,'settled.json'),{turn:current,stable:true,readOnlySource:restore.readOnlySource,inherited:true});
          save(join(to,'measurement.json'),{sample,hiddenGenerationCount:null,inherited:true,sourceDirectory:relative(to,from),readOnlySource:restore.readOnlySource});
          save(join(to,'inherited.json'),{sourceDirectory:relative(to,from),files:['events.jsonl','request.json','collection.json'].map(name=>({name,sha256:sha256(readFileSync(join(from,name)))}))});
          row.samples.push(sample);
        }
        log.write('checkpoint.json',{reference:store.reference,sessionId:restore.session.id,stateRelativePath:relative(log.directory,store.reference.directory),inherited:true});
        log.record('session.restored',{sessionId:restore.session.id,readOnlySource:restore.readOnlySource,completedTurnIds:restore.turns.map(t=>t.id)});
      }
      async function turn(name:string,input:string,ledger:NonNullable<CollectionOptions['ledger']>) {
        for(let attempt=0;;attempt++) {
        if(++turnsDispatched>66) throw new Error('MANAGED_TURN_CAP');
        if(guard.snapshot().admissionEstimateUsd+.2>2) throw new Error('STUDY_ADMISSION_CAP');
        const e=new Evidence(join(log.directory,`${String(sequence++).padStart(2,'0')}-${name}${attempt?`-retry-${attempt}`:''}`),[key]),api=client();
        root.record('managed.reserved',{id,name,reservationUsd:.2,prior:guard.snapshot()});
        console.log(JSON.stringify({event:'managed-turn',id,name,estimateUsd:guard.snapshot().estimateUsd}));
        const result=await collectTrial(api,{...trial,id:`${id}-${name}`},e,guard,{
          request:{...body,input},ledger,
          ...(row.sessionId?{continuation:{sessionId:row.sessionId,input}}:{}),
          onSession:sid=>{if(row.sessionId && row.sessionId!==sid) throw new Error('SESSION_CHANGED');if(!row.sessionId) {
            if(seenSessions.has(sid)) throw new Error('SESSION_REUSED');seenSessions.add(sid);row.sessionId=sid;bindings.bind(sid,store.reference);
          }},
        });
        const events=readFileSync(join(e.directory,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l) as {kind:string;data:any});
        const listed:Turn[]=events.filter(r=>r.kind==='session.turns').flatMap(r=>r.data.data);
        const fresh=listed.filter(t=>!seenTurns.has(t.id));
        if(result.error && (result.error as {code?:string}).code==='internal_error' && row.sessionId && transportRetries<(options.transportRetries??0)) {
          const status=await api.beta.agents.sessions.retrieve(row.sessionId),page=await api.beta.agents.sessions.turns.list(row.sessionId,{order:'asc',limit:100});
          e.record('transport.read-only-check',{session:status,turns:page.data});
          if(canRetryUnestablished(status,page.data,seenTurns,page.hasNextPage())) {
            for(const t of page.data) guard.observeTurn(row.sessionId,t);guard.observeSession(row.sessionId,status.usage);
            guard.reserveUnestablished();guard.check(row.sessionId);transportRetries++;
            e.write('transport-retry.json',{sameInput:true,sameIdempotencyKey:`${id}-${name}`,noNewPublicTurn:true,retainedReservationUsd:.2,attempt:transportRetries});
            root.record('transport.retry',{id,name,attempt:transportRetries,budget:guard.snapshot()});continue;
          }
        }
        if(fresh.length!==1 || !row.sessionId) throw new Error('CURRENT_TURN_UNESTABLISHED');
        const current=fresh[0]!;seenTurns.add(current.id);
        const items:AgentSessionItem[]=events.filter(r=>r.kind==='root.items').flatMap(r=>r.data.data);
        let latest=current,stable=false;
        for(let poll=0;poll<(options.settlementPolls??3);poll++) {
          await delay(options.settlementDelayMs??1000);
          const next=await api.beta.agents.sessions.turns.retrieve(current.id,{session_id:row.sessionId});
          e.record('usage.revision',next);guard.observeTurn(row.sessionId,next);
          stable=!!next.usage && JSON.stringify(next.usage)===JSON.stringify(latest.usage);latest=next;
          if(stable) break;
          if(poll===0 || poll%6===5) console.log(JSON.stringify({event:'usage-pending',id,name,poll:poll+1}));
        }
        guard.requireComplete(row.sessionId);
        e.write('settled.json',{turn:latest,stable,hiddenGenerationCount:null,reason:'Public items do not certify all internal generations.'});
        if(result.error || !stable) throw new Error(result.error?'COLLECTOR_FAILED':'UNSETTLED_USAGE');
        return {log:e,turn:latest,items,complete:result.historyComplete && result.terminal==='agent.session.turn.completed'};
        }
      }
      const noTools={correct:null,handle:()=>{throw new Error('MEASUREMENT_TOOL_CALL');}};
      async function ack(name:string,input=ACK) {
        const t=await turn(name,input,noTools),sample=ackObservation(name,t.turn,t.items,true,t.complete);
        t.log.write('measurement.json',{sample,hiddenGenerationCount:null,model:DEFAULT_MODEL,inputBytes:Buffer.byteLength(input),configurationHash:sha256(JSON.stringify(body.agent))});
        row.samples.push(sample);measurements.push({sample,turnId:t.turn.id,items:t.items,complete:t.complete});
        if(!sample.valid) throw new Error('INVALID_ACK_MEASUREMENT');
        return sample;
      }
      try {
        if(!restore) {
          const setupLog=new Evidence(join(log.directory,'setup-ledger'),[key]);
          const setup=new CheckpointLedger(bindings,'setup',setupLog);
          const start=await turn('setup',body.input as string,setup);
          if(!start.complete || !setup.correct || !row.sessionId) throw new Error('INVALID_SETUP');
          const frozen=store.freeze();bindings.freeze(row.sessionId,frozen);log.write('checkpoint.json',{reference:frozen,sessionId:row.sessionId,stateRelativePath:relative(log.directory,frozen.directory)});
          await ack('baseline-1');
        }
        if(!row.samples.some(s=>s.id==='baseline-2')) await ack('baseline-2');
        let confirming=false;
        for(let dose=1;dose<=4;dose++) {
          const pending=dose===1?restore?.pendingDose:undefined;
          const f=pending?.fact??fact(`block${dose}`);facts.push(f);
          const noise=randomBytes((arm==='pressure'?65536:256)/2).toString('hex');
          const input=pending?.input??`${factText(f)}\nIrrelevant log (do not reproduce): ${noise}\n${ACK}`;
          log.write(`block-${dose}.json`,{fact:f,noiseBytes:Buffer.byteLength(noise),noiseHash:pending?null:sha256(noise),inheritedRequest:pending?.source??null});
          const sample=await ack(`dose-${dose}`,input),before=row.samples.at(-2)!;
          if(drop(before,sample,rule)) {confirming=true;await ack('confirm-1');await ack('confirm-2');break;}
        }
        if(!confirming) {await ack('endpoint-1');await ack('endpoint-2');}
        row.candidate=detect(row.samples,rule);log.write('online-detection.json',{samples:row.samples,rule,candidate:row.candidate,hiddenGenerationCount:null});
        if(arm==='control' || row.candidate) {
          const recall=await turn('recall',recallQuery(facts),noTools);
          const answer=recall.items.filter(i=>i.turn_id===recall.turn.id && i.type==='message' && i.role==='assistant')
            .map(i=>i.type==='message'?i.content.map(c=>'text' in c?c.text:'').join(''):'').join('');
          recall.log.write('recall-score.json',{...scoreRecall(answer,facts),completed:recall.complete,queriedOnce:true,notUsedInDetection:true});
          const indices=[randomInt(512)];let next=randomInt(511);if(next>=indices[0]!) next++;indices.push(next);
          log.write('challenge.json',{selectedAt:new Date().toISOString(),indices,afterCandidate:row.candidate,controlEndpoint:arm==='control'});
          const recoveryLog=new Evidence(join(log.directory,'recovery-ledger'),[key]);
          const base=new CheckpointLedger(bindings,'bound',recoveryLog),records=new RecordLedger(base,indices,recoveryLog);
          const result=await turn('recovery',`Resume the assigned task. Discover saved state, finish pending jobs without requesting completed jobs, and submit tracer_resume_report with every exact original and new result. Also read external indices ${JSON.stringify(indices)} with tracer_state_read and submit their exact values through tracer_state_submit. Correct rejected submissions within tool limits.`,records);
          const restored=bindings.lookup(row.sessionId!)!;restored.verify();
          const obs=base.observation(),duplicate=obs.processAttempts.some(p=>p.status==='already_completed');
          const pass=result.complete && restored.results().length===3 && base.correct===true && records.correct===true && !duplicate;
          row.recovery={pass,checkpoint:obs,recordsCorrect:records.correct,recordReports:records.reports,duplicateCompletedRequest:duplicate,
            sourceIntact:true,originalReceiptIntact:true,operationCount:restored.results().length,firstCheckpointReportCorrect:obs.reports[0]?.accepted??null};
        }
      } catch(error) {row.error=error instanceof Error?error.message:'CASE_FAILED';}
      log.write('result.json',row);root.record('managed.case',row);
      console.log(JSON.stringify({event:'managed-case-completed',id,candidate:row.candidate,recovery:row.recovery,error:row.error,estimateUsd:guard.snapshot().estimateUsd}));
      // Missing usage, cancellation, or an invalid measurement stops paid work, rather than attempting a replacement case.
      if(row.error) throw new Error(row.error);
    }
  } catch(error) {fatal=error instanceof Error?error.message:'MANAGED_FAILED';}
  // Always reconcile read-only, including partially collected sessions. Keep revisions separate from online decisions.
  const reconciliation:unknown[]=[];
  for(const row of cases.filter(c=>c.sessionId)) {
    try {
      const api=client(),turns:Turn[]=[];
      for await(const t of api.beta.agents.sessions.turns.list(row.sessionId!,{order:'asc',limit:100})) {turns.push(t);if(turns.length>100) throw new Error('TURN_PAGE_CAP');guard.observeTurn(row.sessionId!,t);}
      const session=await api.beta.agents.sessions.retrieve(row.sessionId!);guard.observeModel(session.agent.model);guard.observeSession(row.sessionId!,session.usage);
      reconciliation.push({id:row.id,session,turns});
    } catch(error) {reconciliation.push({id:row.id,error:error instanceof Error?error.message:'RECONCILE_FAILED'});}
  }
  root.write('managed-reconciliation.json',{readOnly:true,reconciliation,budget:guard.snapshot()});
  const result={cases,error:fatal,turnsDispatched,transportRetries,budget:guard.snapshot(),mechanism:'unidentified; candidates are usage observations only'};
  root.write('managed.json',result);return result;
}
