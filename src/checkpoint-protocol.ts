import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {SessionCreateParamsStreaming} from 'openai/resources/beta/agents/sessions/sessions';
import {DEFAULT_MODEL, SDK_VERSION, sha256, type Trial} from './protocol.js';
import type {Collected} from './collector.js';
import type {CheckpointLedger, Phase} from './checkpoint-ledger.js';

export const CHECKPOINT_PROTOCOL='checkpoint-resume-v8';
export const CHECKPOINT_LIMITS={studyUsd:2,sessions:9,blocks:3,callsPerSession:6,toolOutputBytes:16384,
  reservations:{setup:0.20,bound:0.25,unbound:0.10}} as const;
export type CheckpointTrial=Trial & {phase:Phase};
export function checkpointTrials(seed: string): CheckpointTrial[] {
  return [1,2,3].flatMap(block=>(block===2?['setup','unbound','bound'] as const:['setup','bound','unbound'] as const)
    .map(phase=>({id:`b${block}-${phase}`,block,phase,arm:'programmatic-local' as const,seed:sha256(`${seed}:${block}`),model:DEFAULT_MODEL})));
}
// arm is a legacy collector field meaning no native children expected; execution is ordinary functions below.
export function checkpointRequest(trial: CheckpointTrial): SessionCreateParamsStreaming {
  const array={type:'array',items:{type:'string'},maxItems:3};
  const setup=trial.phase==='setup';
  return {environment:{type:'none'},stream:true,metadata:{protocol:CHECKPOINT_PROTOCOL,trial:trial.id},
    agent:{model:trial.model,service_tier:'default',reasoning:{effort:'low'},multi_agent:{enabled:false},
      instructions:'Use the provided application function tools to complete this bounded task. Call current_task_state first. It takes no arguments and discovers only the task assigned to this session. Use its exact handle and job IDs. A completed job already has its saved result; never call process_job for a completed job. Process pending jobs sequentially and use exact returned digests and receipts. Do not invent task identity or results. If state is unbound, do not process anything. Do not delegate or use code, web, shell, or external services. Follow the user instruction for setup or resume. After finishing, give a brief status and stop.',
      tools:[{type:'programmatic_tool_calling',enabled:false},
        {type:'function',name:'current_task_state',description:'Discover the task bound by the application to this session. Returns status bound with handle and jobs (pending or completed with saved result), or status unbound with no task data.',
          parameters:{type:'object',properties:{},additionalProperties:false}},
        {type:'function',name:'process_job',description:'Process one pending job using its exact handle and jobId. Returns status executed and result {jobId,digest,receipt}. Completed jobs must not be requested again.',
          parameters:{type:'object',properties:{handle:{type:'string'},jobId:{type:'string'}},required:['handle','jobId'],additionalProperties:false}},
        ...(!setup?[{type:'function' as const,name:'tracer_resume_report',description:'Submit once after resume. If bound, report completed with exact prior/new job IDs and all results. If unbound, report blocked with all three arrays empty.',
          parameters:{type:'object',properties:{status:{type:'string',enum:['completed','blocked']},previouslyCompletedJobIds:array,processedJobIds:array,
            results:{type:'array',maxItems:3,items:{type:'object',properties:{jobId:{type:'string'},digest:{type:'string'},receipt:{type:'string'}},
              required:['jobId','digest','receipt'],additionalProperties:false}}},required:['status','previouslyCompletedJobIds','processedJobIds','results'],additionalProperties:false}}]:[]) ]},
    input:setup?'Setup: discover the assigned task, process ONLY the first pending job in the returned list, then stop. Leave all other jobs pending.':
      'Resume the task assigned to this session. Discover its saved state, finish every pending job without repeating completed work, then submit one exact tracer_resume_report distinguishing previously completed and newly processed jobs. If no task is bound, submit a blocked report with empty arrays. Do not guess.'};
}

export interface CheckpointObservation {
  phase:Phase; collection:Collected; setupValid:boolean; freshIdentity:boolean; cleanRequest:boolean;
  storageIntact:boolean; bindingCorrect:boolean; resultCount:number; priorIds:string[]; pendingIds:string[];
  ledger:ReturnType<CheckpointLedger['observation']>;
}
export function classifyCheckpoint(o:CheckpointObservation) {
  const result=(outcome:'pass'|'negative'|'inconclusive',reason:string)=>({outcome,reason});
  if (o.collection.error || !o.collection.historyComplete || o.collection.terminal!=='agent.session.turn.completed')
    return result('inconclusive','INCOMPLETE_API_LIFECYCLE');
  if (!o.storageIntact || !o.setupValid) return result('inconclusive','MISSING_OR_DAMAGED_CHECKPOINT');
  if (!o.freshIdentity || !o.cleanRequest || !o.bindingCorrect) return result('inconclusive','INVALID_HANDOFF_OR_ISOLATION');
  const attempts=o.ledger.processAttempts;
  if (o.phase==='unbound') {
    if (o.ledger.stateReads.some(s=>s!=='unbound') || attempts.length) return result('negative','UNBOUND_ISOLATION_OR_PROCESS_FAILURE');
    return o.ledger.stateReads.length>0 && o.ledger.reports.length===1 && o.ledger.reports[0]!.accepted===true && !o.ledger.rejectedCalls
      ?result('pass','UNBOUND_REPORTED_BLOCKED'):result('negative','UNBOUND_REPORT_FAILURE');
  }
  if (!o.ledger.stateReads.includes('bound')) return result('negative','TASK_DISCOVERY_FAILED');
  if (attempts.some(a=>a.status==='already_completed')) return result('negative','COMPLETED_JOB_REQUESTED_AGAIN');
  if (o.ledger.rejectedCalls || attempts.some(a=>a.status!=='executed')) return result('negative','JOB_SELECTION_OR_TOOL_FAILURE');
  if (attempts.length!==o.pendingIds.length || !o.pendingIds.every(id=>attempts.filter(a=>a.result?.jobId===id).length===1) ||
      o.resultCount!==o.priorIds.length+o.pendingIds.length) return result('negative','MISSING_OR_REPEATED_WORK');
  if (o.phase==='setup') return o.collection.taskCorrect===true?result('pass','ONE_SETUP_JOB_COMPLETED'):result('negative','INVALID_SETUP');
  return o.ledger.reports.length===1 && o.ledger.reports[0]!.accepted===true
    ?result('pass','CHECKPOINT_RECOVERED_AND_PENDING_JOBS_COMPLETED'):result('negative','RESULT_REPORT_FAILED');
}
export function checkpointRegistration() {
  const reg=JSON.parse(readFileSync('evidence/preregistration-v8.json','utf8'));
  if (reg.protocol!==CHECKPOINT_PROTOCOL || reg.model!==DEFAULT_MODEL || reg.sdk!==SDK_VERSION ||
      reg.protocolHash!==sha256(readFileSync('research/13-checkpoint-resume-protocol.md'))) throw new Error('CHECKPOINT_REGISTRATION_CHANGED');
  return reg;
}
export function claimCheckpointStudy(directory:string,run:string) {
  writeFileSync(join(directory,'dispatch-checkpoint-v8.json'),JSON.stringify({protocol:CHECKPOINT_PROTOCOL,run,
    startedAt:new Date().toISOString(),thresholdUsd:2,automaticRetryAllowed:false})+'\n',{flag:'wx'});
}
