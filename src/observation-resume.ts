import OpenAI from 'openai';
import {existsSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Evidence,safeError} from './evidence.js';
import {DEFAULT_MODEL,SDK_VERSION,sha256} from './protocol.js';
import {studyFetch} from './observation.js';
import {managedStudy} from './observation-managed.js';
import {captureResponses} from './observation-transport.js';
import {CONTINUATION_PROTOCOL,CarriedCalibrationBudget,continuationRegistration,missingCalibrationRequests,completeCalibration,claimContinuation,verifyParent} from './observation-continuation.js';

const mode=process.argv[2];if(!['plan','run'].includes(mode??'') || process.argv.length!==3) throw new Error('Usage: pnpm observation-resume [plan|run]');
const registration=continuationRegistration(),parentAudit=verifyParent(registration.parent);
const sdk=JSON.parse(readFileSync('node_modules/openai/package.json','utf8')).version;if(sdk!==SDK_VERSION) throw new Error('SDK_CHANGED');
if(mode==='plan') console.log(JSON.stringify({registration,paidRequests:0,newCalibrationRequests:missingCalibrationRequests(registration.parent).map(r=>r.name),managedSessions:6,detectorRuleUnchanged:true},null,2));
else {
  if(existsSync('.env')) process.loadEnvFile('.env');
  const key=process.env.OPENAI_API_KEY?.trim()??'';if(!key) throw new Error('MISSING_API_KEY');
  if((process.env.TRACER_MODEL?.trim()||DEFAULT_MODEL)!==DEFAULT_MODEL) throw new Error('MODEL_CHANGED');
  const directory=join('evidence/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${CONTINUATION_PROTOCOL}-${randomUUID().slice(0,8)}`);
  claimContinuation('evidence',directory,registration.parent);
  const log=new Evidence(directory,[key]),budget=new CarriedCalibrationBudget(registration.carriedKnownUsd,registration.carriedUnresolvedUsd),http=studyFetch(fetch);
  const fetcher:typeof fetch=async(input,init)=>{
    const method=init?.method??(input instanceof Request?input.method:'GET');
    const cleanup=method==='GET'||(method==='POST'&&init?.body==='{"events":[{"type":"agent.session.input.cancel"}]}');
    if(http.count()+53>=(cleanup?3000:2970)) throw new Error('CARRIED_HTTP_CAP');
    return http.fetch(input,init);
  };
  const sources=['src/observation-resume.ts','src/observation-continuation.ts','src/observation.ts','src/observation-managed.ts','src/observation-transport.ts',
    'src/observation-replay.ts','src/collector.ts','src/budget.ts','src/evidence.ts','src/protocol.ts','src/checkpoint-store.ts','src/checkpoint-ledger.ts','src/checkpoint-protocol.ts','src/state-store.ts'];
  log.write('manifest.json',{...registration,node:process.version,sdk,modelRequested:DEFAULT_MODEL,pnpmUserAgent:process.env.npm_config_user_agent??null,
    gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sources:sources.map(path=>({path,sha256:sha256(readFileSync(path))})),lockfileSha256:sha256(readFileSync('pnpm-lock.yaml')),
    newAllowance:false,priorHttpAttempts:53,budgetInterpretation:'Managed guard includes the historical 0.03 unresolved reservation in its prior estimate; it is not an observed charge.'});
  log.write('parent-audit.json',parentAudit);
  let calibration:Awaited<ReturnType<typeof completeCalibration>>|null=null,managed:Awaited<ReturnType<typeof managedStudy>>|null=null,error:unknown=null;
  try {
    const client=new OpenAI({apiKey:key,maxRetries:0,timeout:120000,fetch:captureResponses(fetcher,log),...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
    calibration=await completeCalibration(client,log,registration.parent,budget,[key]);
    console.log(JSON.stringify({event:'calibration-completed',pass:calibration.pass,rule:calibration.rule,bridge:calibration.bridge,budget:budget.snapshot()}));
    if(calibration.pass) managed=await managedStudy(log,calibration.rule,budget.snapshot().admissionEstimateUsd,key,fetcher,{protocol:CONTINUATION_PROTOCOL});
  } catch(e) {error={...safeError(e),reason:e instanceof Error && /^[A-Z_]+$/.test(e.message)?e.message:'REQUEST_OR_STUDY_FAILED'};log.tryRecord('continuation.failed',error);}
  const accountingUsd=managed?.budget.admissionEstimateUsd??budget.snapshot().admissionEstimateUsd;
  const result={protocol:CONTINUATION_PROTOCOL,parent:registration.parent,calibrationPassed:calibration?.pass??null,managedCases:managed?.cases.length??0,error,
    managedError:managed?.error??null,calibrationBudget:budget.snapshot(),managedBudget:managed?.budget??null,
    admissionAccountingUsd:accountingUsd,historicalUnresolvedReservationUsd:registration.carriedUnresolvedUsd,
    newHttpAttempts:http.count(),totalHttpAttempts:53+http.count(),newAllowance:false,finishedAt:new Date().toISOString()};
  log.write('result.json',result);console.log(JSON.stringify({event:'continuation-finished',directory,calibrationPassed:result.calibrationPassed,managedCases:result.managedCases,error,managedError:result.managedError,admissionAccountingUsd:accountingUsd}));
  if(error||managed?.error) process.exitCode=1;
}
