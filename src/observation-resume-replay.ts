import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {AgentSessionItem} from 'openai/resources/beta/agents/agents';
import type {Turn} from 'openai/resources/beta/agents/sessions/turns';
import {replayObservation} from './observation-replay.js';
import {joinedCalibration,missingCalibrationRequests} from './observation-continuation.js';
import {CheckpointStore} from './checkpoint-store.js';
import {checkReport,observeCheckpointCalls,type CallRecord} from './checkpoint-ledger.js';
import {sha256} from './protocol.js';
import {ackObservation} from './observation-managed.js';
import {detect} from './observation.js';
import type {StateRecord} from './state-store.js';

const read=<T=any>(p:string):T=>JSON.parse(readFileSync(p,'utf8'));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const events=(dir:string):any[]=>readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
export function auditedRecovery(path:string) {
  const sourcePath=join(path,'checkpoint.json');if(!existsSync(sourcePath)) return null;
  const checkpoint=read(sourcePath),ref=checkpoint.reference,store=new CheckpointStore({...ref,directory:resolve(path,checkpoint.stateRelativePath??'state')});store.verify();
  const log=join(path,'recovery-ledger');if(!existsSync(log)) return {challenged:false,operations:store.results().length,sourceIntact:true,originalReceiptIntact:true};
  const ordered=events(log),calls:CallRecord[]=ordered.filter(e=>e.kind==='function.executed').map(e=>e.data);
  const obs=observeCheckpointCalls(calls),source=read<{records:StateRecord[]}>(join(store.reference.directory,'external-state.json'));
  const challenge=read(join(path,'challenge.json')),indices:number[]=challenge.indices;
  const wanted=indices.map(i=>source.records[i]!);
  const reports=ordered.filter(e=>e.kind==='record.executed'&&e.data.name==='tracer_state_submit').map(e=>{
    const a=e.data.input,rows=a?.records;
    const accepted=a && Object.keys(a).join(',')==='records'&&Array.isArray(rows)&&rows.length===2 && wanted.every(w=>rows.filter(r=>r&&Object.keys(r).sort().join(',')==='index,value'&&r.index===w.index&&r.value===w.value).length===1);
    if(accepted!==JSON.parse(e.data.output).accepted) throw new Error('RECORD_VERDICT_CHANGED');return accepted;
  });
  const prior=store.priorJobIds(),pending=store.task.jobs.map(j=>j.id).filter(id=>!prior.includes(id));
  const exactCheckpoint=obs.reports.map(r=>checkReport(r.input,{prior,jobIds:store.task.jobs.map(j=>j.id),results:store.results()}));
  if(!same(exactCheckpoint,obs.reports.map(r=>r.accepted))) throw new Error('CHECKPOINT_VERDICT_CHANGED');
  const attempts=obs.processAttempts,duplicate=attempts.some(a=>a.status==='already_completed');
  const executed=attempts.filter(a=>a.status==='executed');
  const exactEffects=store.results().length===3&&executed.length===2&&pending.every(id=>executed.filter(a=>a.result?.jobId===id).length===1);
  const folders=readdirSync(path,{withFileTypes:true}).filter(e=>e.isDirectory()&&/\d+-recovery$/.test(e.name));
  const collection=folders.length===1?read(join(path,folders[0]!.name,'collection.json')):null;
  const complete=!!collection&&!collection.error&&collection.historyComplete&&collection.terminal==='agent.session.turn.completed';
  const pass=complete&&exactEffects&&exactCheckpoint.at(-1)===true&&reports.at(-1)===true&&!duplicate;
  return {challenged:true,pass,complete,sourceIntact:true,originalReceiptIntact:true,operations:store.results().length,pendingExecuted:executed.length,
    duplicateCompletedRequest:duplicate,rejectedCheckpointCalls:obs.rejectedCalls,checkpointReports:exactCheckpoint,recordReports:reports,
    firstCheckpointReportCorrect:exactCheckpoint[0]??null,firstRecordReportCorrect:reports[0]??null,selectedIndices:indices};
}
export function replayContinuation(directory:string) {
  const generic=replayObservation(directory),manifest=read(join(directory,'manifest.json'));
  const calibrationRun=manifest.calibrationRun??directory,calibrationParent=manifest.calibrationParent??manifest.parent;
  const joined=joinedCalibration(calibrationParent,calibrationRun);
  if(!same(joined,read(join(directory,'calibration.json')))) throw new Error('JOINED_CALIBRATION_CHANGED');
  for(const r of missingCalibrationRequests(calibrationParent)) if(!same(r.body,read(join(calibrationRun,'calibration-continuation',`${r.name}-request.json`)))) throw new Error('CONTINUATION_REQUEST_CHANGED');
  const final=read(join(directory,'managed-reconciliation.json'));
  const managed=read(join(directory,'managed.json'));
  const cases=managed.cases.map((row:any)=>{
    const path=join(directory,row.id),reconciled=final.reconciliation.find((r:any)=>r.id===row.id);
    const measurements=readdirSync(path,{withFileTypes:true}).filter(e=>e.isDirectory()&&existsSync(join(path,e.name,'measurement.json'))).map(e=>{
      const folder=join(path,e.name),raw=events(folder),saved=read(join(folder,'measurement.json')),settled=read(join(folder,'settled.json'));
      const items:AgentSessionItem[]=raw.filter(e=>e.kind==='root.items').flatMap(e=>e.data.data);
      const collection=read(join(folder,'collection.json'));
      const sample=ackObservation(saved.sample.id,settled.turn,items,settled.stable,collection.historyComplete&&collection.terminal==='agent.session.turn.completed'&&!collection.error);
      if(!same(sample,saved.sample)) throw new Error('ACK_ELIGIBILITY_CHANGED');
      const turn:Turn|undefined=reconciled?.turns?.find((t:Turn)=>t.id===settled.turn.id);
      const revised=turn?ackObservation(saved.sample.id,turn,items,!!turn.usage,collection.historyComplete&&!collection.error):{...sample,input:null,valid:false};
      const snapshot=raw.find(e=>e.kind==='session.snapshot')?.data;
      return {sample,revised,turnId:settled.turn.id,usageChanged:!same(settled.turn.usage,turn?.usage),sessionId:collection.sessionId,
        configurationHash:snapshot?sha256(JSON.stringify({agent:snapshot.agent,environment:snapshot.environment})):null,
        requestPath:relative(directory,join(folder,'request.json'))};
    });
    const online=detect(measurements.map(m=>m.sample),joined.rule),after=detect(measurements.map(m=>m.revised),joined.rule);
    if(!same(online,row.candidate)) throw new Error('CANDIDATE_CHANGED');
    const recovery=auditedRecovery(path);
    if(row.recovery && (!recovery || !('pass' in recovery)||recovery.pass!==row.recovery.pass)) throw new Error('RECOVERY_REPLAY_MISMATCH');
    const sessionStable=measurements.every(m=>m.sessionId===row.sessionId),configHashes=new Set(measurements.map(m=>m.configurationHash));
    return {id:row.id,sessionId:row.sessionId,inputTokens:measurements.map(m=>m.sample.input),cachedTokens:measurements.map(m=>m.sample.cached),
      measurementNames:measurements.map(m=>m.sample.id),validMeasurements:measurements.filter(m=>m.sample.valid).length,onlineCandidate:online,reconciledCandidate:after,
      candidateStable:same(online,after),usageRevisions:measurements.filter(m=>m.usageChanged).map(m=>({id:m.sample.id,old:m.sample.input,new:m.revised.input})),
      sameSession:sessionStable,configurationStable:configHashes.size===1&&!configHashes.has(null),recovery,error:row.error,
      finalStatus:reconciled?.session?.status??null,requiredActions:reconciled?.session?.required_actions?.length??null};
  });
  const pairs=[1,2,3].map(pair=>{
    const control=cases.find((c:any)=>c.id===`b${pair}-control`),pressure=cases.find((c:any)=>c.id===`b${pair}-pressure`);
    let outcome='inconclusive',reason='INCOMPLETE_COMPARISON';
    if(control&&pressure&&!control.error&&!pressure.error&&control.recovery?.pass&&control.sameSession&&pressure.sameSession&&control.configurationStable&&pressure.configurationStable) {
      if(!pressure.reconciledCandidate) reason='NO_CONFIRMED_REDUCTION';
      else if(!pressure.candidateStable) reason='CANDIDATE_REVISED';
      else if(pressure.recovery?.pass) {outcome='survived-observed-reduction';reason='EXACT_RECOVERY_AFTER_CANDIDATE';}
      else if(pressure.recovery?.complete) {outcome='workflow-negative';reason='INCORRECT_RECOVERY_AFTER_CANDIDATE';}
    }
    return {pair,outcome,reason};
  });
  const budget=managed.budget;
  return {readOnly:true,run:directory,calibration:{pass:joined.pass,rule:joined.rule,bridge:joined.bridge,newResponses:generic.calibration.paidResponses,
      newInputTokens:generic.calibration.inputTokens,newOutputTokens:generic.calibration.outputTokens},
    logs:generic.logs,records:generic.records,sourceMatches:generic.sourceMatches,cases,pairs,
    accounting:{admissionEstimateUsd:budget.admissionEstimateUsd,knownEstimateUsd:budget.estimateUsd===null?null:budget.estimateUsd-manifest.carriedUnresolvedUsd,
      historicalUnresolvedReservationUsd:manifest.carriedUnresolvedUsd,newUnknownTurnCount:budget.unknownTurnCount,thresholdUsd:2,newAllowance:false},
    sourceHashes:generic.hashes.map(h=>({...h,path:relative(directory,h.path)}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3) throw new Error('Usage: pnpm observation-resume-replay RUN_DIRECTORY');
  console.log(JSON.stringify(replayContinuation(process.argv[2]!),null,2));
}
