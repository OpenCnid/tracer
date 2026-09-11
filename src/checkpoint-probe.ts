import OpenAI from 'openai';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {authorizePaidInference,boundedFetch,UsageGuard} from './budget.js';
import {collectTrial} from './collector.js';
import {Evidence,safeError} from './evidence.js';
import {DEFAULT_MODEL,LIMITS,SDK_VERSION,sha256} from './protocol.js';
import {CheckpointStore,SessionBindings,type TaskReference} from './checkpoint-store.js';
import {CheckpointLedger} from './checkpoint-ledger.js';
import {checkpointRegistration,checkpointRequest,checkpointTrials,CHECKPOINT_LIMITS,CHECKPOINT_PROTOCOL,
  claimCheckpointStudy,classifyCheckpoint,type CheckpointObservation} from './checkpoint-protocol.js';

const mode=process.argv[2];
if (!['plan','run'].includes(mode??'') || process.argv.length!==3) throw new Error('Usage: pnpm checkpoint-probe [plan|run]');
const registration=checkpointRegistration();
const sdk=JSON.parse(readFileSync('node_modules/openai/package.json','utf8')).version;
if (sdk!==SDK_VERSION) throw new Error('SDK_CHANGED');
if (mode==='plan') {console.log(JSON.stringify({registration,limits:CHECKPOINT_LIMITS,paidRequests:0},null,2));}
else {
  if(existsSync('.env')) process.loadEnvFile('.env');
  const key=process.env.OPENAI_API_KEY?.trim()??'';
  if (!key) throw new Error('MISSING_OPENAI_API_KEY');
  if ((process.env.TRACER_MODEL?.trim()||DEFAULT_MODEL)!==DEFAULT_MODEL) throw new Error('MODEL_CHANGED');
  authorizePaidInference('reported-usage-stop');
  const seed=randomUUID(),trials=checkpointTrials(seed);
  const directory=join('evidence/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${CHECKPOINT_PROTOCOL}-${seed.slice(0,8)}`);
  claimCheckpointStudy('evidence',directory);
  const log=new Evidence(directory,[key]), bindings=new SessionBindings(join(directory,'bindings'));
  const sources=['src/checkpoint-probe.ts','src/checkpoint-protocol.ts','src/checkpoint-store.ts','src/checkpoint-ledger.ts',
    'src/collector.ts','src/budget.ts','src/state-store.ts','src/evidence.ts','src/protocol.ts'];
  log.write('manifest.json',{...registration,trials,seed,limits:{...LIMITS,...CHECKPOINT_LIMITS},modelRequested:DEFAULT_MODEL,sdk,node:process.version,
    pnpmUserAgent:process.env.npm_config_user_agent??null,gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sources:sources.map(path=>({path,sha256:sha256(readFileSync(path))})),lockfileSha256:sha256(readFileSync('pnpm-lock.yaml')),
    priorEstimateUsd:0,overshootAccepted:true,priorStudiesExcluded:true,apiKeyPresent:true,
    execution:'ordinary application functions; PTC disabled; no native children',rootDirectory:resolve(directory)});
  let carriedUsd=0,attempts=0,fatal:unknown=null;
  const summaries:{trial:string;observation:CheckpointObservation;classification:ReturnType<typeof classifyCheckpoint>}[]=[];
  const refs=new Map<number,TaskReference>(); const setups=new Map<number,{sessionId:string;valid:boolean}>();
  const seenSessions=new Set<string>();
  console.log(JSON.stringify({event:'checkpoint-study-started',directory,thresholdUsd:2}));
  try {
    for(const trial of trials) {
      if (trial.phase==='setup') {
        const store=CheckpointStore.create(join(directory,`task-${trial.block}`)); refs.set(trial.block,store.reference);
        log.record('task.created',{block:trial.block,reference:store.reference});
      } else if (!setups.get(trial.block)?.valid) {log.record('session.skipped',{trial:trial.id,reason:'MISSING_VALID_SETUP'});continue;}
      const reference=refs.get(trial.block)!;
      const before=new CheckpointStore(reference);
      const reservation=CHECKPOINT_LIMITS.reservations[trial.phase];
      if(carriedUsd+reservation>2) throw new Error('STUDY_ADMISSION_CAP');
      const guard=new UsageGuard(DEFAULT_MODEL,2,reservation,carriedUsd);
      const evidence=new Evidence(join(directory,trial.id),[key]);
      const ledger=new CheckpointLedger(bindings,trial.phase,evidence),request=checkpointRequest(trial);
      const priorIds=trial.phase==='setup'?[]:before.priorJobIds();
      const pendingIds=trial.phase==='setup'?[before.task.jobs[0]!.id]:before.task.jobs.filter(j=>!priorIds.includes(j.id)).map(j=>j.id);
      const forbidden=[before.task.id,before.task.handle,...before.task.jobs.map(j=>j.id),...before.results().flatMap(r=>[r.digest,r.receipt]),
        ...(setups.get(trial.block)?[setups.get(trial.block)!.sessionId]:[])];
      const cleanRequest=forbidden.every(value=>!JSON.stringify(request).includes(value));
      if (!cleanRequest) throw new Error('TASK_DATA_IN_INITIAL_REQUEST');
      evidence.write('handoff.json',{phase:trial.phase,taskDirectory:relative(evidence.directory,reference.directory),reference,
        setupSessionId:setups.get(trial.block)?.sessionId??null,priorIds,pendingIds,cleanRequest});
      log.record('session.reserved',{trial:trial.id,reservation,carriedUsd});attempts++;
      console.log(JSON.stringify({event:'checkpoint-session-started',trial:trial.id,reservation,carriedUsd}));
      let freshIdentity=false,bindingCorrect=false;
      const client=new OpenAI({apiKey:key,maxRetries:0,timeout:LIMITS.deadlineMs,fetch:boundedFetch(fetch),
        ...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
      const collection=await collectTrial(client,trial,evidence,guard,{request,ledger,onSession:sessionId=>{
        freshIdentity=!seenSessions.has(sessionId);if (!freshIdentity) throw new Error('SESSION_NOT_FRESH');
        seenSessions.add(sessionId);guard.observeSession(sessionId,null);
        if (trial.phase!=='unbound') bindings.bind(sessionId,reference);
        const restored=bindings.lookup(sessionId);
        bindingCorrect=trial.phase==='unbound'?restored===null:restored?.reference.taskHash===reference.taskHash;
        evidence.record('binding.established',{sessionId,bound:!!restored,taskHash:restored?.reference.taskHash??null,
          freshIdentity,reopenedFromDisk:true});
      }});
      let storageIntact=true,resultCount=0;
      try {resultCount=new CheckpointStore(reference).results().length;}catch {storageIntact=false;}
      const observation:CheckpointObservation={phase:trial.phase,collection,setupValid:trial.phase==='setup'||setups.get(trial.block)?.valid===true,
        freshIdentity,cleanRequest,storageIntact,bindingCorrect,resultCount,priorIds,pendingIds,ledger:ledger.observation()};
      const classification=classifyCheckpoint(observation);
      const summary={trial:trial.id,observation,classification};summaries.push(summary);
      evidence.write('result.json',summary);log.record('session.collected',summary);
      carriedUsd=collection.sessionId?guard.snapshot().admissionEstimateUsd:carriedUsd+reservation;
      console.log(JSON.stringify({event:'checkpoint-session-finished',trial:trial.id,classification,error:collection.error,carriedUsd}));
      if (collection.error) throw new Error('COLLECTOR_FAILED');
      if (trial.phase==='setup' && classification.outcome==='pass' && collection.sessionId) {
        const frozen=before.freeze();refs.set(trial.block,frozen);setups.set(trial.block,{sessionId:collection.sessionId,valid:true});
        log.record('checkpoint.frozen',{block:trial.block,reference:frozen});
      }
    }
  } catch(error) {fatal={...safeError(error),reason:error instanceof Error?error.message:'UNKNOWN'};log.tryRecord('study.stopped',fatal);}
  const fresh=summaries.filter(s=>s.observation.phase!=='setup');
  const outcome=fresh.some(s=>s.classification.outcome==='negative')?'negative-for-tested-workflow':
    !fatal && fresh.length===6 && fresh.every(s=>s.classification.outcome==='pass')?'supported-for-tested-workflow':'inconclusive';
  const result={protocol:CHECKPOINT_PROTOCOL,outcome,summaries,error:fatal,inputAttempts:attempts,
    conservativeAdmissionEstimateUsd:carriedUsd,thresholdUsd:2,invoice:false,overshootPossible:true,
    managedCompaction:'unmeasured',finishedAt:new Date().toISOString()};
  log.write('result.json',result);console.log(JSON.stringify({event:'checkpoint-study-finished',directory,outcome,attempts,carriedUsd,error:fatal}));
  if(fatal) process.exitCode=1;
}
