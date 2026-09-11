import OpenAI from 'openai';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Evidence,safeError} from './evidence.js';
import {DEFAULT_MODEL,SDK_VERSION,sha256} from './protocol.js';
import {OBS_PROTOCOL,ObservationBudget,studyFetch} from './observation.js';
import {calibrate} from './observation-calibration.js';
import {managedStudy} from './observation-managed.js';
import {captureResponses} from './observation-transport.js';

const sources=['src/observation.ts','src/observation-probe.ts','src/observation-calibration.ts','src/observation-managed.ts','src/observation-replay.ts','src/observation-transport.ts',
  'src/collector.ts','src/budget.ts','src/evidence.ts','src/checkpoint-protocol.ts','src/checkpoint-store.ts','src/checkpoint-ledger.ts','src/state-store.ts','src/protocol.ts'];
const mode=process.argv[2];
if(!['plan','run'].includes(mode??'') || process.argv.length!==3) throw new Error('Usage: pnpm observation-probe [plan|run]');
const registration=JSON.parse(readFileSync('evidence/preregistration-v9.json','utf8'));
if(registration.protocol!==OBS_PROTOCOL || registration.model!==DEFAULT_MODEL || registration.sdk!==SDK_VERSION || registration.protocolHash!==sha256(readFileSync('research/16-observation-protocol.md'))) throw new Error('REGISTRATION_CHANGED');
const sdk=JSON.parse(readFileSync('node_modules/openai/package.json','utf8')).version;
if(sdk!==SDK_VERSION) throw new Error('SDK_CHANGED');
if(mode==='plan') console.log(JSON.stringify({registration,thresholdUsd:2,calibrationRequests:57,managedSessions:6,managedTurns:66,paidCalls:0},null,2));
else {
  if(existsSync('.env')) process.loadEnvFile('.env');
  const key=process.env.OPENAI_API_KEY?.trim()??'';if(!key) throw new Error('MISSING_OPENAI_API_KEY');
  if((process.env.TRACER_MODEL?.trim()||DEFAULT_MODEL)!==DEFAULT_MODEL) throw new Error('MODEL_CHANGED');
  const directory=join('evidence/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${OBS_PROTOCOL}-${randomUUID().slice(0,8)}`);
  writeFileSync('evidence/dispatch-observation-v9.json',JSON.stringify({protocol:OBS_PROTOCOL,run:directory,startedAt:new Date().toISOString(),thresholdUsd:2,automaticRetryAllowed:false})+'\n',{flag:'wx'});
  const log=new Evidence(directory,[key]),budget=new ObservationBudget(),http=studyFetch(fetch);
  log.write('manifest.json',{...registration,node:process.version,sdk,modelRequested:DEFAULT_MODEL,
    pnpmUserAgent:process.env.npm_config_user_agent??null,gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sources:sources.map(path=>({path,sha256:sha256(readFileSync(path))})),lockfileSha256:sha256(readFileSync('pnpm-lock.yaml')),
    sharedThresholdUsd:2,overshootAccepted:true,priorStudiesExcluded:true});
  let calibration:Awaited<ReturnType<typeof calibrate>>|null=null,managed:Awaited<ReturnType<typeof managedStudy>>|null=null,error:unknown=null;
  try {
    const api=new OpenAI({apiKey:key,maxRetries:0,timeout:120000,fetch:captureResponses(http.fetch,log),...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
    calibration=await calibrate(api,log,budget,[key]);
    if(calibration.pass && calibration.rule) managed=await managedStudy(log,calibration.rule,budget.snapshot().admissionEstimateUsd,key,http.fetch);
  } catch(e) {error={...safeError(e),reason:e instanceof Error && /^[A-Z_]+$/.test(e.message)?e.message:'REQUEST_OR_STUDY_FAILED'};log.tryRecord('study.failed',error);}
  const result={protocol:OBS_PROTOCOL,calibrationPassed:calibration?.pass??null,managedCases:managed?.cases.length??0,
    managedError:managed?.error??null,error,calibrationBudget:budget.snapshot(),sharedBudget:managed?.budget??null,httpRequests:http.count(),
    survivalConclusion:'inconclusive until evidence replay and paired comparison',finishedAt:new Date().toISOString()};
  log.write('result.json',result);console.log(JSON.stringify({event:'study-finished',directory,...result}));
  if(error || managed?.error) process.exitCode=1;
}
