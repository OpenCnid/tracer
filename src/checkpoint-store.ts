import {randomBytes, randomInt} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {StateStore, type StateRecord} from './state-store.js';
import {sha256} from './protocol.js';

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value)+'\n', {flag:'wx'});
const hash = (path: string) => sha256(readFileSync(path));
export interface Job {id: string; index: number}
export interface Receipt {jobId: string; digest: string; receipt: string}
interface Task {id: string; handle: string; sourceHash: string; jobs: Job[]}
interface Checkpoint {taskHash: string; sourceHash: string; completed: {jobId: string; hash: string}[]}
export interface TaskReference {directory: string; taskHash: string; sourceHash: string; checkpointHash: string|null}

export class CheckpointStore {
  readonly task: Task;
  constructor(readonly reference: TaskReference) {
    if (hash(join(reference.directory,'task.json')) !== reference.taskHash) throw new Error('TASK_CHANGED');
    this.task = read<Task>(join(reference.directory,'task.json'));
    this.verify();
  }
  static create(directory: string) {
    mkdirSync(join(directory,'operations'), {recursive:true});
    const source = new StateStore(directory);
    const indices = new Set<number>(); while(indices.size < 3) indices.add(randomInt(512));
    const task: Task = {id:`task_${randomBytes(16).toString('hex')}`,handle:source.handle,sourceHash:source.sha256,
      jobs:[...indices].map(index=>({id:`job_${randomBytes(12).toString('hex')}`,index}))};
    save(join(directory,'task.json'),task);
    return new CheckpointStore({directory:resolve(directory),taskHash:hash(join(directory,'task.json')),
      sourceHash:source.sha256,checkpointHash:null});
  }
  private receiptPath(id: string) {
    if (!this.task.jobs.some(job=>job.id===id)) throw new Error('INVALID_JOB');
    return join(this.reference.directory,'operations',`${id}.json`);
  }
  verify() {
    const ref = this.reference;
    if (hash(join(ref.directory,'task.json')) !== ref.taskHash) throw new Error('TASK_CHANGED');
    if (hash(join(ref.directory,'external-state.json')) !== ref.sourceHash || this.task.sourceHash!==ref.sourceHash)
      throw new Error('SOURCE_CHANGED');
    if (ref.checkpointHash) {
      if (hash(join(ref.directory,'checkpoint.json'))!==ref.checkpointHash) throw new Error('CHECKPOINT_CHANGED');
      const checkpoint = read<Checkpoint>(join(ref.directory,'checkpoint.json'));
      if (checkpoint.taskHash!==ref.taskHash || checkpoint.sourceHash!==ref.sourceHash) throw new Error('CHECKPOINT_CHANGED');
      for(const result of checkpoint.completed) {
        if (!existsSync(this.receiptPath(result.jobId)) || hash(this.receiptPath(result.jobId))!==result.hash)
          throw new Error('COMPLETED_RESULT_CHANGED');
      }
    }
    const source = read<{records: StateRecord[]}>(join(ref.directory,'external-state.json'));
    for(const job of this.task.jobs) {
      if (!existsSync(this.receiptPath(job.id))) continue;
      const receipt = read<Receipt>(this.receiptPath(job.id));
      if (receipt.jobId!==job.id || receipt.digest!==sha256(source.records[job.index]!.value) ||
          !/^[a-f0-9]{48}$/.test(receipt.receipt)) throw new Error('INVALID_RESULT');
    }
  }
  results(): Receipt[] {
    this.verify();
    return this.task.jobs.flatMap(job=>existsSync(this.receiptPath(job.id))?[read<Receipt>(this.receiptPath(job.id))]:[]);
  }
  manifest() {
    const results = this.results();
    return {status:'bound',handle:this.task.handle,jobs:this.task.jobs.map(job=>({jobId:job.id,index:job.index,
      status:results.some(r=>r.jobId===job.id)?'completed':'pending',result:results.find(r=>r.jobId===job.id)??null}))};
  }
  process(handle: unknown, jobId: unknown) {
    this.verify();
    if (handle!==this.task.handle) return {status:'rejected',reason:'INVALID_HANDLE'} as const;
    const job = this.task.jobs.find(j=>j.id===jobId);
    if (!job) return {status:'rejected',reason:'INVALID_JOB'} as const;
    const path = this.receiptPath(job.id);
    if (existsSync(path)) return {status:'already_completed',result:read<Receipt>(path)} as const;
    const source = read<{records: StateRecord[]}>(join(this.reference.directory,'external-state.json'));
    const result: Receipt = {jobId:job.id,digest:sha256(source.records[job.index]!.value),receipt:randomBytes(24).toString('hex')};
    // The exclusively created file IS the operation. No remote side effect is claimed.
    save(path,result);
    return {status:'executed',result} as const;
  }
  freeze() {
    const results = this.results();
    if (results.length!==1 || results[0]!.jobId!==this.task.jobs[0]!.id) throw new Error('INVALID_SETUP_CHECKPOINT');
    const checkpoint: Checkpoint = {taskHash:this.reference.taskHash,sourceHash:this.reference.sourceHash,
      completed:results.map(r=>({jobId:r.jobId,hash:hash(this.receiptPath(r.jobId))}))};
    save(join(this.reference.directory,'checkpoint.json'),checkpoint);
    return {...this.reference,checkpointHash:hash(join(this.reference.directory,'checkpoint.json'))};
  }
  priorJobIds() {
    this.verify();
    return this.reference.checkpointHash ? read<Checkpoint>(join(this.reference.directory,'checkpoint.json')).completed.map(r=>r.jobId) : [];
  }
}

export class SessionBindings {
  constructor(readonly directory: string) {mkdirSync(directory,{recursive:true});}
  private path(sessionId: string) {return join(this.directory,`${sha256(sessionId)}.json`);}
  bind(sessionId: string, task: TaskReference) {
    new CheckpointStore(task).verify();
    save(this.path(sessionId),{sessionId,task});
  }
  lookup(sessionId: string): CheckpointStore|null {
    if (!existsSync(this.path(sessionId))) return null;
    const binding = read<{sessionId:string;task:TaskReference}>(this.path(sessionId));
    if (binding.sessionId!==sessionId) throw new Error('BINDING_CHANGED');
    return new CheckpointStore(binding.task);
  }
}
