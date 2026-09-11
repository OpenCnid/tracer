import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentSession} from 'openai/resources/beta/agents/agents';
import {Evidence} from './evidence.js';
import {sha256} from './protocol.js';
import {CheckpointStore, SessionBindings, type Receipt} from './checkpoint-store.js';

export type Phase = 'setup'|'bound'|'unbound';
type Action = Extract<AgentSession['required_actions'][number],{type:'function_call'}>;
export interface CallRecord {key:string;args:string;name:string;input:unknown;output:string}
const sameIds = (actual: unknown, expected: string[]) => Array.isArray(actual) && actual.length===expected.length &&
  expected.every(id=>actual.filter(value=>value===id).length===1);
export function exactReport(input: unknown, store: CheckpointStore|null) {
  return checkReport(input,store?{prior:store.priorJobIds(),jobIds:store.task.jobs.map(j=>j.id),results:store.results()}:null);
}
export function checkReport(input: unknown, context: {prior:string[];jobIds:string[];results:Receipt[]}|null) {
  if (!input || typeof input!=='object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',')!=='previouslyCompletedJobIds,processedJobIds,results,status') return false;
  const report = input as {status:unknown;previouslyCompletedJobIds:unknown;processedJobIds:unknown;results:unknown};
  if (!context) return report.status==='blocked' && sameIds(report.previouslyCompletedJobIds,[]) &&
    sameIds(report.processedJobIds,[]) && Array.isArray(report.results) && report.results.length===0;
  const {prior,results}=context;
  return report.status==='completed' && sameIds(report.previouslyCompletedJobIds,prior) &&
    sameIds(report.processedJobIds,context.jobIds.filter(id=>!prior.includes(id))) &&
    results.length===context.jobIds.length && Array.isArray(report.results) && report.results.length===results.length &&
    results.every(wanted=>(report.results as unknown[]).filter(r=>r && typeof r==='object' &&
      Object.keys(r).sort().join(',')==='digest,jobId,receipt' && (r as Receipt).jobId===wanted.jobId &&
      (r as Receipt).digest===wanted.digest && (r as Receipt).receipt===wanted.receipt).length===1);
}

export class CheckpointLedger {
  readonly calls: CallRecord[] = [];
  correct: boolean|null = null;
  private readonly directory: string;
  constructor(readonly bindings: SessionBindings, readonly phase: Phase, readonly evidence: Evidence) {
    this.directory = join(evidence.directory,'calls'); mkdirSync(this.directory,{recursive:true});
    for(const file of readdirSync(this.directory).sort()) this.calls.push(JSON.parse(readFileSync(join(this.directory,file),'utf8')));
    const report = this.calls.filter(c=>c.name==='tracer_resume_report').at(-1);
    if (report) this.correct=JSON.parse(report.output).accepted;
  }
  handle(sessionId: string, action: Action) {
    const key = `${sessionId}:${action.turn_id}:${action.call_id}`;
    const args = JSON.stringify({name:action.name,arguments:action.arguments});
    const file = join(this.directory,`${sha256(key)}.json`);
    if (existsSync(file)) {
      const old = JSON.parse(readFileSync(file,'utf8')) as CallRecord;
      if (old.key!==key || old.args!==args) throw new Error('CHANGED_DUPLICATE_CALL');
      this.evidence.record('function.reused',{key}); return old.output;
    }
    if (this.calls.length>=6) throw new Error('TOOL_EXECUTION_CAP');
    // Reserve a conservative maximum response before any operation can take place.
    if (this.calls.reduce((n,c)=>n+Buffer.byteLength(c.output),0)+4096>16384) throw new Error('TOOL_OUTPUT_BYTE_CAP');
    const store = this.bindings.lookup(sessionId);
    const input = action.arguments as Record<string,unknown>;
    let value: unknown;
    if (!input || typeof input!=='object' || Array.isArray(input)) value={status:'rejected',reason:'INVALID_ARGUMENTS'};
    else if (action.name==='current_task_state' && Object.keys(input).length===0) value=store?.manifest()??{status:'unbound'};
    else if (action.name==='process_job' && Object.keys(input).sort().join(',')==='handle,jobId')
      value=store?.process(input.handle,input.jobId)??{status:'rejected',reason:'UNBOUND'};
    else if (action.name==='tracer_resume_report' && this.phase!=='setup') {
      this.correct=exactReport(input,store); value={accepted:this.correct};
    } else value={status:'rejected',reason:'INVALID_TOOL_OR_ARGUMENTS'};
    const output = JSON.stringify(value);
    if (Buffer.byteLength(output)>4096) throw new Error('TOOL_OUTPUT_BYTE_CAP');
    const record: CallRecord = {key,args,name:action.name,input:action.arguments,output};
    writeFileSync(file,JSON.stringify(record)+'\n',{flag:'wx'}); // Durable before network delivery.
    this.calls.push(record); this.evidence.record('function.executed',record);
    if (this.phase==='setup') {
      const effects=this.calls.filter(c=>c.name==='process_job').map(c=>JSON.parse(c.output));
      this.correct=!!store && this.calls.some(c=>c.name==='current_task_state' && JSON.parse(c.output).status==='bound') &&
        effects.length===1 && effects[0].status==='executed' && effects[0].result.jobId===store.task.jobs[0]!.id;
    }
    return output;
  }
  observation() {
    return observeCheckpointCalls(this.calls);
  }
}
export function observeCheckpointCalls(calls:CallRecord[]) {
  return {logicalCalls:calls.length,stateReads:calls.filter(c=>c.name==='current_task_state').map(c=>JSON.parse(c.output).status),
    processAttempts:calls.filter(c=>c.name==='process_job').map(c=>({input:c.input,...JSON.parse(c.output)})),
    reports:calls.filter(c=>c.name==='tracer_resume_report').map(c=>({input:c.input,accepted:JSON.parse(c.output).accepted})),
    rejectedCalls:calls.filter(c=>JSON.parse(c.output).status==='rejected').length};
}
