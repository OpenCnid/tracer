// Offline validation from original files and ordered call records, without inference or file mutation.
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {CheckpointStore,type TaskReference,type Receipt} from './checkpoint-store.js';
import {checkReport,observeCheckpointCalls,type CallRecord} from './checkpoint-ledger.js';
import {checkpointRequest,classifyCheckpoint,CHECKPOINT_PROTOCOL,type CheckpointTrial,type CheckpointObservation} from './checkpoint-protocol.js';
import {verifyLog} from './evidence.js';
import {sha256} from './protocol.js';

const directory=process.argv[2];if(!directory) throw new Error('Usage: pnpm checkpoint-replay <study-directory>');
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const equal=(a:unknown,b:unknown,reason:string)=>{if(!isDeepStrictEqual(a,b))throw new Error(reason);};
let logs=0,records=0;
function events(path:string) {
  records+=verifyLog(path);logs++;
  return readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
const manifest=read(join(directory,'manifest.json')),result=read(join(directory,'result.json'));
if (manifest.protocol!==CHECKPOINT_PROTOCOL || result.protocol!==CHECKPOINT_PROTOCOL) throw new Error('WRONG_PROTOCOL');
equal(sha256(readFileSync('research/13-checkpoint-resume-protocol.md')),manifest.protocolHash,'PROTOCOL_CHANGED');
for(const file of manifest.sources) equal(sha256(readFileSync(file.path)),file.sha256,'IMPLEMENTATION_CHANGED');
equal(sha256(readFileSync('pnpm-lock.yaml')),manifest.lockfileSha256,'LOCKFILE_CHANGED');
const root=events(join(directory,'events.jsonl'));
const sessionIds=new Set<string>(),effects=new Map<number,Map<string,Receipt>>(),rows:unknown[]=[];
let redeliveries=0,operationCount=0,duplicateAttempts=0;
for(const trial of manifest.trials as CheckpointTrial[]) {
  const dir=join(directory,trial.id);if(!existsSync(join(dir,'collection.json')))continue;
  const handoff=read(join(dir,'handoff.json')),collection=read(join(dir,'collection.json')),saved=read(join(dir,'result.json'));
  const ev=events(join(dir,'events.jsonl')),request=read(join(dir,'request.json'));
  equal(request,checkpointRequest(trial),'INITIAL_REQUEST_CHANGED');
  const reference:TaskReference={...handoff.reference,directory:resolve(dir,handoff.taskDirectory)};
  const taskCreated=root.find(e=>e.kind==='task.created'&&e.data.block===trial.block)?.data.reference;
  equal(reference.taskHash,taskCreated?.taskHash,'REFERENCE_TASK_MISMATCH');equal(reference.sourceHash,taskCreated?.sourceHash,'REFERENCE_SOURCE_MISMATCH');
  const frozen=root.find(e=>e.kind==='checkpoint.frozen'&&e.data.block===trial.block)?.data.reference;
  if(trial.phase!=='setup') equal(reference.checkpointHash,frozen?.checkpointHash,'FROZEN_CHECKPOINT_MISMATCH');
  const store=new CheckpointStore(reference),source=read(join(reference.directory,'external-state.json'));
  const calls=ev.filter(e=>e.kind==='function.executed').map(e=>e.data as CallRecord);
  equal(readdirSync(join(dir,'calls')).length,calls.length,'DURABLE_CALL_COUNT_MISMATCH');
  for(const call of calls) equal(read(join(dir,'calls',`${sha256(call.key)}.json`)),call,'DURABLE_CALL_CHANGED');
  redeliveries+=ev.filter(e=>e.kind==='function.reused').length;
  const bindingEvent=ev.find(e=>e.kind==='binding.established')?.data;
  let bindingCorrect=false;
  if(collection.sessionId) {
    const path=join(directory,'bindings',`${sha256(collection.sessionId)}.json`);
    if(trial.phase==='unbound') bindingCorrect=!existsSync(path) && bindingEvent?.bound===false;
    else {
      const binding=read(path);
      bindingCorrect=binding.sessionId===collection.sessionId && isDeepStrictEqual(binding.task,handoff.reference) &&
        bindingEvent?.taskHash===reference.taskHash;
    }
  }
  const forbidden=[store.task.handle,store.task.id,...store.task.jobs.map(j=>j.id),...store.results().flatMap(r=>[r.digest,r.receipt]),
    ...(handoff.setupSessionId?[handoff.setupSessionId]:[])];
  const cleanRequest=forbidden.every(v=>!JSON.stringify(request).includes(v));
  const freshIdentity=!!collection.sessionId&&!sessionIds.has(collection.sessionId);sessionIds.add(collection.sessionId);
  const done=effects.get(trial.block)??new Map<string,Receipt>();effects.set(trial.block,done);
  const prior=trial.phase==='setup'?[]:store.priorJobIds();
  for(const call of calls) {
    const output=JSON.parse(call.output),input=call.input as Record<string,unknown>;
    if (call.name==='current_task_state') {
      const expected=trial.phase==='unbound'?{status:'unbound'}:{status:'bound',handle:store.task.handle,jobs:store.task.jobs.map(j=>({
        jobId:j.id,index:j.index,status:done.has(j.id)?'completed':'pending',result:done.get(j.id)??null}))};
      if(output.status!=='rejected') equal(output,expected,'MANIFEST_NOT_FROM_BOUND_DURABLE_STATE');
    }
    if(call.name==='process_job') {
      if(output.status==='executed') {
        if(trial.phase==='unbound' || input.handle!==store.task.handle || done.has(output.result.jobId)) throw new Error('UNAUTHORIZED_OR_REPEATED_EFFECT');
        const job=store.task.jobs.find(j=>j.id===input.jobId);if(!job)throw new Error('UNKNOWN_EFFECT_JOB');
        equal(output.result.jobId,job.id,'JOB_RESULT_MISMATCH');equal(output.result.digest,sha256(source.records[job.index].value),'DIGEST_ORACLE_MISMATCH');
        equal(output.result,read(join(reference.directory,'operations',`${job.id}.json`)),'EFFECT_FILE_CHANGED');
        done.set(job.id,output.result);operationCount++;
      } else if(output.status==='already_completed') {
        equal(output.result,done.get(String(input.jobId)),'INCORRECT_DUPLICATE_RESULT');duplicateAttempts++;
      }
    }
    if(call.name==='tracer_resume_report') {
      equal(output.accepted,checkReport(input,trial.phase==='unbound'?null:{prior,jobIds:store.task.jobs.map(j=>j.id),results:[...done.values()]}),'REPORT_ORACLE_MISMATCH');
    }
  }
  const observation:CheckpointObservation={phase:trial.phase,collection,setupValid:trial.phase==='setup'||!!frozen,
    freshIdentity,cleanRequest,storageIntact:true,bindingCorrect,resultCount:done.size,priorIds:prior,
    pendingIds:trial.phase==='setup'?[store.task.jobs[0]!.id]:store.task.jobs.filter(j=>!prior.includes(j.id)).map(j=>j.id),ledger:observeCheckpointCalls(calls)};
  equal(observation,saved.observation,'OBSERVATION_REPLAY_MISMATCH');
  equal(classifyCheckpoint(observation),saved.classification,'CLASSIFICATION_REPLAY_MISMATCH');
  rows.push({trial:trial.id,classification:saved.classification});
}
equal(result.summaries.map((s:{trial:string;classification:unknown})=>({trial:s.trial,classification:s.classification})),rows,'COHORT_ROW_MISMATCH');
const reconciliation=readdirSync(directory).filter(name=>name.startsWith('reconcile-')).sort().at(-1);
let reconciled:unknown=null;
if(reconciliation) {
  const rec=read(join(directory,reconciliation,'result.json'));const ev=events(join(directory,reconciliation,'events.jsonl'));
  reconciled={directory:reconciliation,readOnly:rec.readOnly,sessions:rec.summaries.length,
    errors:ev.filter(e=>e.kind==='error').length,allIdle:rec.summaries.every((s:{sessionStatus:string})=>s.sessionStatus==='idle'),
    allTurnsComplete:rec.summaries.every((s:{turns:{status:string}[]})=>s.turns.length===1&&s.turns[0]!.status==='completed'),
    pendingActions:rec.summaries.reduce((n:number,s:{pendingActions:number})=>n+s.pendingActions,0),budget:rec.budget};
}
console.log(JSON.stringify({offline:true,protocol:CHECKPOINT_PROTOCOL,logsVerified:logs,recordsVerified:records,sessionIds:sessionIds.size,
  operations:operationCount,duplicateAttempts,transportRedeliveries:redeliveries,rows,reconciled,managedCompaction:'unmeasured'},null,2));
