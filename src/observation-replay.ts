import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import type {Turn} from 'openai/resources/beta/agents/sessions/turns';
import type {Response as ModelResponse} from 'openai/resources/responses/responses';
import {verifyLog} from './evidence.js';
import {sha256,SDK_VERSION,DEFAULT_MODEL} from './protocol.js';
import {ARMS,detect,chooseRule,calibrationPass,scoreRecall,type Sample,type Arm,type Rule,type Fact} from './observation.js';
import {CheckpointStore} from './checkpoint-store.js';

const read=<T=any>(path:string):T=>JSON.parse(readFileSync(path,'utf8'));
function files(dir:string):string[] {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function replayObservation(directory:string) {
  const manifest=read(join(directory,'manifest.json'));
  if(manifest.sdk!==SDK_VERSION || manifest.modelRequested!==DEFAULT_MODEL) throw new Error('MANIFEST_CHANGED');
  const sourceMatches=manifest.sources.map((s:{path:string;sha256:string})=>({path:s.path,
    workingTreeMatches:existsSync(s.path)&&sha256(readFileSync(s.path))===s.sha256,
    recordedCommitMatches:sha256(execFileSync('git',['show',`${manifest.gitCommit}:${s.path}`]))===s.sha256}));
  const all=files(directory),logs=all.filter(p=>p.endsWith('events.jsonl'));
  const logRecords=logs.map(path=>({path,records:verifyLog(path)}));
  const fixtures:unknown[]=[];
  const lockPath=join(directory,'detector-lock.json'),locked:Rule|null=existsSync(lockPath)?read(lockPath).rule:null;
  let paidResponses=0,inputTokens=0,outputTokens=0;
  for(const path of all.filter(p=>p.endsWith('-response.json'))) {
    const response=read<ModelResponse>(path);paidResponses++;
    if(response.usage) {inputTokens+=response.usage.input_tokens;outputTokens+=response.usage.output_tokens;}
  }
  for(const id of ['development','heldout-1','heldout-2']) {
    const path=join(directory,id);if(!existsSync(path)) continue;
    if(!existsSync(join(path,'result.json'))) {
      // Salvage observations without treating an unfinished scheduled fixture as a passed gate.
      const trajectory:Partial<Record<Arm,Sample[]>>={},recall:Partial<Record<Arm,unknown>>={};
      const events=readFileSync(join(path,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse as (text:string)=>any);
      for(const arm of ARMS) {
        const names=['pre-1','pre-2',`${arm}-post-1`,`${arm}-post-2`,`${arm}-post-3`];
        if(names.every(name=>existsSync(join(path,`${name}-response.json`)))) {
          trajectory[arm]=names.map(name=>{
            const r=read<ModelResponse>(join(path,`${name}-response.json`)),event=events.find(e=>e.kind==='request.completed'&&e.data.name===name);
            return {id:name,at:event?.at??new Date(r.created_at*1000).toISOString(),input:r.usage?.input_tokens??null,
              cached:r.usage?.input_tokens_details.cached_tokens??null,output:r.usage?.output_tokens??null,
              valid:r.status==='completed' && r.output_text.trim()==='ACK' && !!r.usage && r.output.every(o=>['message','reasoning'].includes(o.type)),reasons:[]};
          });
        }
        if(existsSync(join(path,`${arm}-recall-score.json`))) recall[arm]=read(join(path,`${arm}-recall-score.json`));
      }
      fixtures.push({id,complete:false,pass:null,reason:'SCHEDULE_INCOMPLETE',candidates:locked?Object.fromEntries(Object.entries(trajectory).map(([arm,s])=>[arm,detect(s,locked)])):null,
        inputTrajectories:Object.fromEntries(Object.entries(trajectory).map(([arm,s])=>[arm,s.map(v=>v.input)])),recall});
      continue;
    }
    const stored=read(join(path,'result.json')),fixture=read(join(path,'fixture.json'));
    const trajectories={} as Record<Arm,Sample[]>;
    for(const arm of ARMS) {
      trajectories[arm]=stored.trajectories[arm].map((s:Sample)=>{
        const response=read<ModelResponse>(join(path,`${s.id}-response.json`));
        const valid=response.status==='completed' && response.output_text.trim()==='ACK' && !!response.usage && response.output.every(o=>['message','reasoning'].includes(o.type));
        if(s.input!==response.usage?.input_tokens || s.cached!==response.usage?.input_tokens_details.cached_tokens || s.output!==response.usage?.output_tokens || s.valid!==valid) throw new Error('MEASUREMENT_REPLAY_MISMATCH');
        return s;
      });
      const recall=read<ModelResponse>(join(path,`${arm}-recall-response.json`));
      const facts:Fact[]=[fixture.facts[0],fixture.facts[3],fixture.facts[6],fixture.facts[7],fixture.recent];
      if(!equal(scoreRecall(recall.output_text,facts),stored.recall[arm])) throw new Error('RECALL_REPLAY_MISMATCH');
    }
    const compact=read(join(path,'compact-response.json'));
    for(let i=1;i<=3;i++) {
      const request=read(join(path,`compact-post-${i}-request.json`));
      if(!equal(request.input.slice(0,compact.output.length),compact.output)) throw new Error('CANONICAL_PREFIX_CHANGED');
    }
    if(id==='development' && !equal(chooseRule(trajectories),locked)) throw new Error('LEARNED_RULE_CHANGED');
    const pass=locked!==null && calibrationPass(trajectories,locked);
    if(stored.pass!==pass) throw new Error('CALIBRATION_REPLAY_MISMATCH');
    fixtures.push({id,complete:true,pass,candidates:locked?Object.fromEntries(ARMS.map(arm=>[arm,detect(trajectories[arm],locked)])):null,
      inputTrajectories:Object.fromEntries(ARMS.map(a=>[a,trajectories[a].map(s=>s.input)])),recall:stored.recall});
  }
  const managed:unknown[]=[];
  const reconciled=existsSync(join(directory,'managed-reconciliation.json'))?read(join(directory,'managed-reconciliation.json')).reconciliation:[];
  for(const entry of readdirSync(directory,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^b[1-3]-(control|pressure)$/.test(e.name))) {
    const path=join(directory,entry.name);if(!existsSync(join(path,'result.json'))) continue;
    const result=read(join(path,'result.json')),samples:Sample[]=result.samples;
    const settled=files(path).filter(p=>p.endsWith('settled.json')).map(p=>read(p));
    const final=reconciled.find((r:any)=>r.id===entry.name);
    const revisions:unknown[]=[];
    const revised=samples.map(s=>{
      const measurement=all.find(p=>p.endsWith('measurement.json')&&p.includes(`${entry.name}${process.platform==='win32'?'\\':'/'}`)&&read(p).sample.id===s.id);
      if(!measurement) throw new Error('MEASUREMENT_FILE_MISSING');
      if(!equal(read(measurement).sample,s)) throw new Error('MANAGED_MEASUREMENT_CHANGED');
      const turn:Turn=read(join(measurement.slice(0,-'measurement.json'.length),'settled.json')).turn;
      const latest:Turn|undefined=final?.turns?.find((t:Turn)=>t.id===turn.id);
      const changed=!latest?.usage || !equal(latest.usage,turn.usage);
      revisions.push({id:s.id,turnId:turn.id,changed,original:turn.usage,final:latest?.usage??null});
      return {...s,input:latest?.usage?.input_tokens??null,cached:latest?.usage?.input_tokens_details.cached_tokens??null,
        output:latest?.usage?.output_tokens??null,valid:s.valid&&!!latest?.usage};
    });
    const online=locked?detect(samples,locked):null,after=locked?detect(revised,locked):null;
    if(!equal(online,result.candidate)) throw new Error('ONLINE_DETECTION_CHANGED');
    let storage:unknown=null;
    if(existsSync(join(path,'checkpoint.json'))) {
      const checkpoint=read(join(path,'checkpoint.json')),ref=checkpoint.reference;
      const store=new CheckpointStore({...ref,directory:resolve(path,checkpoint.stateRelativePath??'state')});store.verify();
      storage={sourceIntact:true,originalReceiptIntact:true,operations:store.results().length,prior:store.priorJobIds()};
    }
    managed.push({id:entry.name,onlineCandidate:online,reconciledCandidate:after,candidateStable:equal(online,after),revisions,
      settledTurns:settled.length,storage,recovery:result.recovery,error:result.error});
  }
  return {readOnly:true,manifestProtocol:manifest.protocol,sourceMatches,logs:logRecords.length,records:logRecords.reduce((n,l)=>n+l.records,0),
    calibration:{paidResponses,inputTokens,outputTokens,estimateUsd:(inputTokens*.5+outputTokens*1.8)/1e6,rule:locked,fixtures},managed,
    hashes:all.filter(p=>!p.endsWith('events.jsonl')).map(path=>({path,sha256:sha256(readFileSync(path))}))};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3) throw new Error('Usage: pnpm observation-replay RUN_DIRECTORY');
  console.log(JSON.stringify(replayObservation(process.argv[2]!),null,2));
}
