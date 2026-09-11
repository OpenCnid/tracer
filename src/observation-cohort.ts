import OpenAI from 'openai';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Evidence,safeError} from './evidence.js';
import {DEFAULT_MODEL,SDK_VERSION,sha256} from './protocol.js';
import {studyFetch} from './observation.js';
import {FIXED_RULE} from './observation-continuation.js';
import {managedStudy,ObservationBindings} from './observation-managed.js';
import {auditedRecovery} from './observation-resume-replay.js';
import {readOnlyRetryFetch} from './observation-transport.js';
import {boundedFetch} from './budget.js';

const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
if(process.argv[2]!=='run'||process.argv.length!==3) throw new Error('Usage: pnpm exec tsx src/observation-cohort.ts run');
const reg=read('evidence/preregistration-v10-cohort.json');
for(const [path,hash] of [['research/22-finish-managed-cohort-addendum.md',reg.protocolHash],
  [join(reg.parent,'result.json'),reg.parentResultHash],['src/observation.ts',reg.detectorHash]])
  if(sha256(readFileSync(path))!==hash) throw new Error('COHORT_REGISTRATION_CHANGED');
const parent=read(join(reg.parent,'managed.json')),prior=read(join(reg.parent,'managed-reconciliation.json')).reconciliation[0];
const calibrationManifest=read(join(reg.calibrationRun,'manifest.json'));
const audit=auditedRecovery(join(reg.parent,'b1-control'));
if(parent.cases.length!==1||!audit||!('pass' in audit)||!audit.pass||prior.turns.length!==11||parent.budget.unknownTurnCount!==0||
  Math.abs(parent.budget.admissionEstimateUsd-.4721708)>1e-9) throw new Error('PARENT_CONTROL_UNVERIFIED');
if(existsSync('.env')) process.loadEnvFile('.env');
const key=process.env.OPENAI_API_KEY?.trim()??'';if(!key) throw new Error('MISSING_API_KEY');
if((process.env.TRACER_MODEL?.trim()||DEFAULT_MODEL)!==DEFAULT_MODEL||read('node_modules/openai/package.json').version!==SDK_VERSION) throw new Error('MODEL_OR_SDK_CHANGED');
const directory=join('evidence/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${reg.protocol}-${randomUUID().slice(0,8)}`);
writeFileSync('evidence/dispatch-observation-v10-cohort.json',JSON.stringify({protocol:reg.protocol,parent:reg.parent,run:directory,startedAt:new Date().toISOString(),newAllowance:false,totalThresholdUsd:2,priorHttpAttempts:reg.priorHttpAttempts})+'\n',{flag:'wx'});
const root=new Evidence(directory,[key]),preflight=new Evidence(join(directory,'preflight'),[key]),http=studyFetch(fetch);
const fetcher:typeof fetch=async(input,init)=>{
  const method=init?.method??(input instanceof Request?input.method:'GET'),cleanup=method==='GET'||init?.body==='{"events":[{"type":"agent.session.input.cancel"}]}';
  if(http.count()+reg.priorHttpAttempts>=(cleanup?3000:2970)) throw new Error('CARRIED_HTTP_CAP');return http.fetch(input,init);
};
const sources=['src/observation-cohort.ts','src/observation-managed.ts','src/observation-transport.ts','src/observation.ts','src/observation-continuation.ts',
  'src/observation-resume-replay.ts','src/collector.ts','src/evidence.ts','src/budget.ts','src/protocol.ts','src/checkpoint-store.ts','src/checkpoint-ledger.ts','src/checkpoint-protocol.ts','src/state-store.ts'];
root.write('manifest.json',{...reg,modelRequested:DEFAULT_MODEL,sdk:SDK_VERSION,node:process.version,pnpmUserAgent:process.env.npm_config_user_agent??null,
  calibrationParent:calibrationManifest.parent,gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sources:sources.map(path=>({path,sha256:sha256(readFileSync(path))})),lockfileSha256:sha256(readFileSync('pnpm-lock.yaml')),
  newAllowance:false,inheritedPaidTurns:11,readOnlyPolls:18,readOnlyPollIntervalMs:5000,readOnlyRetries:2,remainingTransportRetries:1});
root.write('calibration.json',read(join(reg.calibrationRun,'calibration.json')));
let managed:Awaited<ReturnType<typeof managedStudy>>|null=null,error:unknown=null;
try {
  const api=new OpenAI({apiKey:key,maxRetries:0,timeout:30000,fetch:readOnlyRetryFetch(boundedFetch(fetcher),preflight),...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
  const id=prior.session.id,session=await api.beta.agents.sessions.retrieve(id);
  const turns=await api.beta.agents.sessions.turns.list(id,{order:'asc',limit:100}),items=await api.beta.agents.sessions.items.list(id,{order:'asc',limit:100});
  preflight.record('read-only.snapshot',{session,turns:turns.data,items:items.data});
  if(turns.hasNextPage()||items.hasNextPage()||session.status!=='idle'||session.required_actions.length||turns.data.length!==11||
    turns.data.some((t,i)=>t.status!=='completed'||!t.usage||t.id!==prior.turns[i].id||!same(t.usage,prior.turns[i].usage))||
    !same(session.agent,prior.session.agent)||!same(session.environment,prior.session.environment)) throw new Error('RESTORE_PREFLIGHT_CHANGED');
  const store=new ObservationBindings(join(reg.bindingParent,'bindings')).lookup(id);
  if(!store||store.results().length!==3||store.priorJobIds().length!==1) throw new Error('RESTORE_STATE_INVALID');
  preflight.write('result.json',{passed:true,readOnly:true,sessionId:id,turnIds:turns.data.map(t=>t.id),audit,originalControlError:parent.cases[0].error});
  managed=await managedStudy(root,FIXED_RULE,reg.priorAdmissionUsd,key,fetcher,{
    protocol:'context-observation-v10',restore:{parent:reg.bindingParent,session,turns:turns.data,items:items.data,readOnlySource:join(preflight.directory,'events.jsonl')},
    completedControl:{directory:join(reg.parent,'b1-control'),row:{...parent.cases[0],error:null,recovery:audit}},
    settlementPolls:18,settlementDelayMs:5000,transportRetries:1,readOnlyRetries:true});
} catch(e) {error={...safeError(e),reason:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'COHORT_FAILED'};root.tryRecord('cohort.failed',error);}
const result={protocol:reg.protocol,error,managedError:managed?.error??null,managedCases:managed?.cases.length??0,budget:managed?.budget??null,
  newHttpAttempts:http.count(),totalHttpAttempts:reg.priorHttpAttempts+http.count(),newAllowance:false,finishedAt:new Date().toISOString()};
root.write('result.json',result);console.log(JSON.stringify({event:'cohort-finished',directory,error,managedError:result.managedError,managedCases:result.managedCases,accountingUsd:managed?.budget.admissionEstimateUsd}));
if(error||managed?.error) process.exitCode=1;
