import OpenAI from 'openai';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Evidence,safeError} from './evidence.js';
import {DEFAULT_MODEL,SDK_VERSION,sha256} from './protocol.js';
import {studyFetch} from './observation.js';
import {FIXED_RULE} from './observation-continuation.js';
import {managedStudy,ObservationBindings,ackObservation,matchesCompletedAck} from './observation-managed.js';

const read=<T=any>(path:string):T=>JSON.parse(readFileSync(path,'utf8'));
const mode=process.argv[2];if(!['plan','run','transport-plan','transport-run','adoption-plan','adoption-run'].includes(mode??'') || process.argv.length!==3) throw new Error('INVALID_COMPLETION_MODE');
const adoption=mode!.startsWith('adoption-'),transport=mode!.startsWith('transport-')||adoption,stage=adoption?'adoption':transport?'transport':'completion';
const reg=read(`evidence/preregistration-v10-${stage}.json`);
const calibrationRun=reg.calibrationRun??reg.parent,bindingParent=reg.bindingParent??reg.parent;
for(const [path,hash] of [[reg.protocolPath??'research/19-managed-usage-settlement-addendum.md',reg.protocolHash],[join(reg.parent,'result.json'),reg.parentResultHash],
  [join(calibrationRun,'calibration.json'),reg.calibrationHash],['src/observation.ts',reg.detectorHash]]) if(sha256(readFileSync(path))!==hash) throw new Error('COMPLETION_REGISTRATION_CHANGED');
const parentResult=read(join(reg.parent,'result.json')),calibrationResult=read(join(calibrationRun,'result.json')),parentManifest=read(join(calibrationRun,'manifest.json'));
const priorResolved=transport&&!adoption?read(reg.resolvedSnapshot).reconciliation[0]:readFileSync(reg.resolvedSnapshot,'utf8').trim().split('\n').map(l=>JSON.parse(l)).find(e=>e.kind==='read-only.snapshot').data;
if(!calibrationResult.calibrationPassed || (adoption?parentResult.error?.reason!=='RESTORE_PREFLIGHT_CHANGED':parentResult.managedCases!==1 || parentResult.managedError!==(transport?'CURRENT_TURN_UNESTABLISHED':'FINAL_USAGE_INCOMPLETE'))) throw new Error('UNEXPECTED_PARENT_STATE');
if(mode!.endsWith('plan')) console.log(JSON.stringify({registration:reg,sessionId:priorResolved.session.id,paidRequests:0,existingTurns:priorResolved.turns.length,fixedRule:FIXED_RULE},null,2));
else {
  if(existsSync('.env')) process.loadEnvFile('.env');
  const key=process.env.OPENAI_API_KEY?.trim()??'';if(!key) throw new Error('MISSING_API_KEY');
  if((process.env.TRACER_MODEL?.trim()||DEFAULT_MODEL)!==DEFAULT_MODEL || read('node_modules/openai/package.json').version!==SDK_VERSION) throw new Error('MODEL_OR_SDK_CHANGED');
  // Claim before network access so repeated invocations cannot create paid work or uncounted preflights.
  const directory=join('evidence/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${reg.protocol}-${randomUUID().slice(0,8)}`);
  writeFileSync(`evidence/dispatch-observation-v10-${stage}.json`,JSON.stringify({protocol:reg.protocol,parent:reg.parent,run:directory,startedAt:new Date().toISOString(),newAllowance:false,totalThresholdUsd:2,priorHttpAttempts:reg.priorHttpAttempts})+'\n',{flag:'wx'});
  const root=new Evidence(directory,[key]),preflight=new Evidence(join(directory,'preflight'),[key]),http=studyFetch(fetch);
  const fetcher:typeof fetch=async(input,init)=>{
    const method=init?.method??(input instanceof Request?input.method:'GET'),cleanup=method==='GET'||init?.body==='{"events":[{"type":"agent.session.input.cancel"}]}';
    if(http.count()+reg.priorHttpAttempts>=(cleanup?3000:2970)) throw new Error('CARRIED_HTTP_CAP');return http.fetch(input,init);
  };
  const sources=['src/observation-managed-completion.ts','src/observation-managed.ts','src/observation.ts','src/observation-continuation.ts',
    'src/collector.ts','src/evidence.ts','src/budget.ts','src/protocol.ts','src/checkpoint-store.ts','src/checkpoint-ledger.ts','src/checkpoint-protocol.ts','src/state-store.ts'];
  root.write('manifest.json',{...reg,modelRequested:DEFAULT_MODEL,sdk:SDK_VERSION,node:process.version,pnpmUserAgent:process.env.npm_config_user_agent??null,
    calibrationRun,calibrationParent:parentManifest.parent,carriedUnresolvedUsd:.03+(reg.transportReservationUsd??0),calibrationAdmissionUsd:calibrationResult.calibrationBudget.admissionEstimateUsd,
    gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sources:sources.map(path=>({path,sha256:sha256(readFileSync(path))})),lockfileSha256:sha256(readFileSync('pnpm-lock.yaml')),
    newAllowance:false,inheritedPaidTurns:priorResolved.turns.length,readOnlyPolls:18,readOnlyPollIntervalMs:5000});
  root.write('calibration.json',read(join(calibrationRun,'calibration.json')));
  let managed:Awaited<ReturnType<typeof managedStudy>>|null=null,error:unknown=null;
  try {
    const api=new OpenAI({apiKey:key,maxRetries:0,timeout:10000,fetch:fetcher,...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
    const id=priorResolved.session.id,session=await api.beta.agents.sessions.retrieve(id);
    const turnPage=await api.beta.agents.sessions.turns.list(id,{order:'asc',limit:100}),itemPage=await api.beta.agents.sessions.items.list(id,{order:'asc',limit:100});
    preflight.record('read-only.snapshot',{session,turns:turnPage.data,items:itemPage.data});
    if(turnPage.hasNextPage()||itemPage.hasNextPage()||session.status!=='idle'||session.required_actions.length||turnPage.data.length!==priorResolved.turns.length||
      turnPage.data.some((t,i)=>t.status!=='completed'||!t.usage||t.id!==priorResolved.turns[i].id||JSON.stringify(t.usage)!==JSON.stringify(priorResolved.turns[i].usage))||
      JSON.stringify(session.agent)!==JSON.stringify(priorResolved.session.agent)||JSON.stringify(session.environment)!==JSON.stringify(priorResolved.session.environment)) throw new Error('RESTORE_PREFLIGHT_CHANGED');
    const store=new ObservationBindings(join(bindingParent,'bindings')).lookup(id);
    if(!store || store.results().length!==1 || store.priorJobIds().length!==1 || turnPage.data.slice(1).some((t,i)=>!ackObservation(`baseline-${i+1}`,t,itemPage.data,true,true).valid)) throw new Error('RESTORE_STATE_INVALID');
    preflight.write('result.json',{readOnly:true,passed:true,sessionId:id,turnIds:turnPage.data.map(t=>t.id),stateReference:store.reference,stableUsage:true});
    const inheritedFrom=reg.previousCompletion??reg.parent;
    let adoptedDirectory:string|null=null;
    if(adoption) {
      const from=join(inheritedFrom,'b1-control/03-dose-1'),request=read(join(from,'request.json')),turn=turnPage.data[3]!;
      if(!matchesCompletedAck(request.input,turn,itemPage.data)) throw new Error('ADOPTED_INPUT_MISMATCH');
      const adopted=new Evidence(join(directory,'adopted-dose-1'),[key]);adoptedDirectory=adopted.directory;
      adopted.record('root.items',{page:0,data:itemPage.data});adopted.record('session.turns',{page:0,data:turnPage.data});adopted.record('session.snapshot',session);
      adopted.write('request.json',request);adopted.write('collection.json',read(join(from,'collection.json')));
      adopted.write('adopted-collection.json',{...read<Record<string,unknown>>(join(from,'collection.json')),error:null,historyComplete:true,terminal:'agent.session.turn.completed',completionBasis:'read-only-turn-resource',originalDirectory:from,inputSha256:sha256(request.input)});
      adopted.write('measurement.json',{sample:ackObservation('dose-1',turn,itemPage.data,true,true),adopted:true});
      adopted.write('settled.json',{turn,stable:true,readOnlySource:join(preflight.directory,'events.jsonl')});
    }
    managed=await managedStudy(root,FIXED_RULE,calibrationResult.calibrationBudget.admissionEstimateUsd+(reg.transportReservationUsd??0),key,fetcher,
      {protocol:'context-observation-v10',restore:{parent:bindingParent,session,turns:turnPage.data,items:itemPage.data,readOnlySource:join(preflight.directory,'events.jsonl'),
        ...(adoption?{measurementDirectories:[join(inheritedFrom,'b1-control/01-baseline-1'),join(inheritedFrom,'b1-control/02-baseline-2'),adoptedDirectory!],completedFacts:[read(join(inheritedFrom,'b1-control/block-1.json')).fact]}:
          transport?{measurementDirectories:[join(reg.parent,'b1-control/01-baseline-1'),join(reg.parent,'b1-control/02-baseline-2')],pendingDose:{fact:read(join(reg.parent,'b1-control/block-1.json')).fact,input:read(join(reg.parent,'b1-control/03-dose-1/request.json')).input,source:join(reg.parent,'b1-control/03-dose-1/request.json')}}:{})},
        settlementPolls:18,settlementDelayMs:5000,transportRetries:transport?2:0});
  } catch(e) {error={...safeError(e),reason:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'COMPLETION_FAILED'};root.tryRecord('completion.failed',error);}
  const result={protocol:reg.protocol,error,managedError:managed?.error??null,managedCases:managed?.cases.length??0,budget:managed?.budget??null,
    newHttpAttempts:http.count(),totalHttpAttempts:reg.priorHttpAttempts+http.count(),newAllowance:false,finishedAt:new Date().toISOString()};
  root.write('result.json',result);console.log(JSON.stringify({event:'managed-completion-finished',directory,error,managedError:result.managedError,managedCases:result.managedCases,accountingUsd:managed?.budget.admissionEstimateUsd}));
  if(error||managed?.error) process.exitCode=1;
}
