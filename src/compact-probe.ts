import OpenAI from 'openai';
import {randomBytes, randomInt, randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {toResponseInputItems} from 'openai/lib/responses/ResponseInputItems';
import type {CompactedResponse, Response as ModelResponse, ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall, ResponseInputItem} from 'openai/resources/responses/responses';
import {Evidence, safeError} from './evidence.js';
import {StateStore, type StateRecord} from './state-store.js';
import {DEFAULT_MODEL, SDK_VERSION, sha256} from './protocol.js';
import {CompactBudget, compactFetch} from './compact-budget.js';
import {claimCompactStudy, classifyCompact, COMPACT_INSTRUCTIONS, COMPACT_LIMITS, COMPACT_PROTOCOL,
  COMPACT_TOOLS, compactBoundary, compactQuery, compactRegistration, continuation,
  visibleHandlePaths, type CompactArmResult} from './compact-protocol.js';

export const compactSources = ['src/compact-probe.ts','src/compact-protocol.ts','src/compact-budget.ts',
  'src/state-store.ts','src/evidence.ts','src/protocol.ts','src/budget.ts'];
function onlyCall(response: ModelResponse, name: string): ResponseFunctionToolCall|null {
  const calls = response.output.filter(i=>i.type==='function_call');
  return calls.length===1 && calls[0]!.name===name ? calls[0]! : null;
}
function exactRecords(actual: unknown, expected: StateRecord[]) {
  if (!actual || typeof actual!=='object' || Object.keys(actual).join(',')!=='records') return false;
  const rows=(actual as {records:unknown}).records;
  return Array.isArray(rows) && rows.length===2 && expected.every(w=>rows.filter(r=>r &&
    typeof r==='object' && Object.keys(r).sort().join(',')==='index,value' && r.index===w.index && r.value===w.value).length===1);
}

export async function runCompactStudy(client: OpenAI, evidence: Evidence, budget: CompactBudget, pairs:number=COMPACT_LIMITS.pairs, secrets:string[]=[]) {
  const summaries: unknown[]=[]; let fatal: unknown=null;
  async function paid<T extends ModelResponse|CompactedResponse>(log:Evidence,name:string,body:unknown,compact:boolean,call:()=>Promise<{data:T;response:globalThis.Response}>) {
    log.write(`${name}-request.json`,body);
    budget.reserve(`${log.directory}/${name}`,compact);
    evidence.record('request.reserved',{name,log:log.directory,budget:budget.snapshot()});
    console.log(JSON.stringify({event:'request-started',name,compact,estimateUsd:budget.snapshot().estimateUsd}));
    try {
      const {data,response}=await call();
      log.write(`${name}-response.json`,data);
      log.record('request.completed',{name,id:data.id,requestId:response.headers.get('x-request-id'),
        endpoint:compact?'/responses/compact':'/responses',usage:data.usage,
        modelReturned:'model' in data?data.model:null,outputSha256:sha256(JSON.stringify(data.output))});
      budget.settle(data.usage);
      if ('model' in data && data.model!==DEFAULT_MODEL) throw new Error('UNEXPECTED_RETURNED_MODEL');
      evidence.record('request.accounted',{name,budget:budget.snapshot()});
      return data;
    } catch(error) {
      log.tryRecord('request.failed',{requestName:name,...safeError(error),message:error instanceof Error?error.message.slice(0,500):null,
        budget:budget.snapshot(),serverCancellationEstablished:false});
      throw error;
    }
  }
  const generate=(log:Evidence,name:string,input:ResponseInputItem[],tool:'manifest'|'read'|'submit'|null) => {
    const body:ResponseCreateParamsNonStreaming={model:DEFAULT_MODEL,input,instructions:COMPACT_INSTRUCTIONS,
      store:false,background:false,stream:false,service_tier:'default',reasoning:{effort:'low'},
      include:['reasoning.encrypted_content'],parallel_tool_calls:false,
      max_output_tokens:tool==='submit'?COMPACT_LIMITS.submitOutputTokens:COMPACT_LIMITS.normalOutputTokens,
      tools:tool?[COMPACT_TOOLS[tool]]:[],tool_choice:tool==='manifest'?{type:'function',name:'tracer_manifest'}:tool?'auto':'none'};
    return paid(log,name,body,false,()=>client.responses.create(body).withResponse());
  };
  async function lookup(log:Evidence,context:ResponseInputItem[],query:string,store:StateStore,indices:number[]):Promise<CompactArmResult> {
    const intact=()=>store.integrity().actualSha256===store.sha256;
    let result:CompactArmResult={readStatus:'not-run',stateIntact:intact(),submissionCorrect:null};
    const input=continuation(context,query);
    if(JSON.stringify(input.slice(0,-1))!==JSON.stringify(context)) throw new Error('CONTEXT_PREFIX_CHANGED');
    log.record('lookup.context',{prefixSha256:sha256(JSON.stringify(context)),querySha256:sha256(query),
      contextHandlePaths:visibleHandlePaths(context,store.handle),newQueryHandlePaths:visibleHandlePaths(query,store.handle),
      instructionsHandlePaths:visibleHandlePaths(COMPACT_INSTRUCTIONS,store.handle)});
    const read=await generate(log,'read',input,'read');
    if(read.status!=='completed') result.readStatus='incomplete';
    else {
      const call=onlyCall(read,'tracer_state_read');
      if(!call) result.readStatus=read.output_text.trim()==='MISSING_HANDLE'?'missing-handle':'invalid-call';
      else {
        let args:Record<string,unknown>|null=null;
        try {args=JSON.parse(call.arguments);} catch { /* Stored call remains reviewable. */ }
        if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).sort().join(',')!=='handle,indices') result.readStatus='invalid-call';
        else if(args.handle!==store.handle) result.readStatus='invalid-handle';
        else if(JSON.stringify(args.indices)!==JSON.stringify(indices)) result.readStatus='wrong-indices';
        else {
          const records=store.read(args.handle as string,indices);
          const original=JSON.parse(readFileSync(store.path,'utf8')) as {records:StateRecord[]};
          const expected=indices.map(i=>original.records[i]!);
          if(JSON.stringify(records)!==JSON.stringify(expected)) throw new Error('ORACLE_READ_MISMATCH');
          result.readStatus='valid';
          const output=JSON.stringify({records});
          log.write('read-result.json',{callId:call.call_id,output,outputSha256:sha256(output),
            state:store.integrity(),indices,oracleMatched:true});
          log.record('function.executed',{name:call.name,callId:call.call_id,arguments:args,output,stateSha256:store.sha256});
          const submitInput:ResponseInputItem[]=[...input,...toResponseInputItems(read.output),
            {type:'function_call_output',call_id:call.call_id,output}];
          const submitted=await generate(log,'submit',submitInput,'submit');
          const submit=onlyCall(submitted,'tracer_state_submit');
          if(submitted.status==='completed' && submit) {
            let payload:unknown=null;try{payload=JSON.parse(submit.arguments);}catch{/* Invalid payload is a failed submission. */}
            result.submissionCorrect=exactRecords(payload,expected);
            log.record('function.executed',{name:submit.name,callId:submit.call_id,arguments:payload,
              output:JSON.stringify({accepted:result.submissionCorrect}),stateSha256:store.sha256});
          } else if(submitted.status==='completed') result.submissionCorrect=false;
        }
        if(result.readStatus!=='valid') log.record('function.rejected',{call,reason:result.readStatus});
      }
    }
    result.stateIntact=intact();log.write('result.json',result);return result;
  }
  try {
    for(let pair=1;pair<=pairs;pair++) {
      const log=new Evidence(join(evidence.directory,`pair-${pair}`),secrets);
      const store=new StateStore(log.directory);
      const notes=randomBytes(COMPACT_LIMITS.notesBytes/2).toString('hex');
      log.write('fixture.json',{...store.manifest(),state:store.integrity(),notesBytes:Buffer.byteLength(notes),notesSha256:sha256(notes)});
      const first:ResponseInputItem[]=[{role:'user',content:'Setup: request the manifest for later external-state lookups. Its notes are irrelevant synthetic data. Retain the exact handle internally and acknowledge setup with Ready. Do not read records yet.'}];
      const manifestResponse=await generate(log,'manifest',first,'manifest');
      const manifestCall=onlyCall(manifestResponse,'tracer_manifest');
      let manifestArguments:unknown=null;
      try {manifestArguments=manifestCall?JSON.parse(manifestCall.arguments):null;} catch {/* Invalid setup is retained and stops the study. */}
      if(manifestResponse.status!=='completed' || !manifestCall || !manifestArguments || typeof manifestArguments!=='object' ||
        Array.isArray(manifestArguments) || Object.keys(manifestArguments).length) throw new Error('SETUP_MANIFEST_NOT_ESTABLISHED');
      const manifestOutput=JSON.stringify({...store.manifest(),irrelevantNotes:notes});
      log.record('function.executed',{name:'tracer_manifest',callId:manifestCall.call_id,output:manifestOutput});
      const second:ResponseInputItem[]=[...first,...toResponseInputItems(manifestResponse.output),
        {type:'function_call_output',call_id:manifestCall.call_id,output:manifestOutput}];
      const ready=await generate(log,'ready',second,null);
      if(ready.status!=='completed') throw new Error('SETUP_ACKNOWLEDGEMENT_INCOMPLETE');
      const history=[...second,...toResponseInputItems(ready.output)];
      log.write('history.json',{input:history,sha256:sha256(JSON.stringify(history)),handlePaths:visibleHandlePaths(history,store.handle)});
      const body={model:DEFAULT_MODEL,input:history,instructions:COMPACT_INSTRUCTIONS,service_tier:'default' as const};
      const compacted=await paid(log,'compact',body,true,()=>client.responses.compact(body).withResponse());
      const boundary=compactBoundary(compacted,store.handle);log.write('boundary.json',boundary);
      // The endpoint's output is already a canonical input window; never normalize it.
      const compactContext=compacted.output as ResponseInputItem[];
      const a=randomInt(512);let b=randomInt(511);if(b>=a)b++;
      const indices=[a,b], query=compactQuery(indices);
      if(visibleHandlePaths([query,COMPACT_INSTRUCTIONS],store.handle).length) throw new Error('HANDLE_REINTRODUCED');
      log.write('query.json',{selectedAt:new Date().toISOString(),afterCompactId:compacted.id,indices,query,sha256:sha256(query)});
      const order=pair%2?['control','treatment'] as const:['treatment','control'] as const;
      const arms:Partial<Record<'control'|'treatment',CompactArmResult>>={};
      for(const arm of order) arms[arm]=await lookup(new Evidence(join(log.directory,arm),secrets),arm==='control'?history:compactContext,query,store,indices);
      const summary={pair,order,indices,boundary,control:arms.control!,treatment:arms.treatment!,
        classification:classifyCompact(arms.control!,arms.treatment!,boundary,true)};
      log.write('result.json',summary);summaries.push(summary);evidence.record('pair.completed',summary);
      console.log(JSON.stringify({event:'pair-completed',...summary}));
    }
  } catch(error) {
    fatal={...safeError(error),message:error instanceof Error?error.message.slice(0,500):null};
    evidence.tryRecord('study.stopped',{error:fatal,budget:budget.snapshot()});
  }
  const rows=summaries as {classification:{outcome:string}}[];
  const outcome=rows.some(r=>r.classification.outcome==='refuted-for-tested-workflow')?'refuted-for-tested-workflow':
    !fatal && rows.length===COMPACT_LIMITS.pairs && rows.every(r=>r.classification.outcome==='supported-for-fixture')?'supported-at-tested-boundaries':'inconclusive';
  const result={protocol:COMPACT_PROTOCOL,outcome,summaries,error:fatal,budget:budget.snapshot(),
    managedAgentsConclusion:'unmeasured',finishedAt:new Date().toISOString()};
  evidence.write('result.json',result);return result;
}

async function main() {
  const mode=process.argv[2];if(!['plan','run'].includes(mode??'') || process.argv.length!==3) throw new Error('Usage: pnpm compact-probe [plan|run]');
  const registration=compactRegistration();
  const sdk=JSON.parse(readFileSync('node_modules/openai/package.json','utf8')).version;
  if(sdk!==SDK_VERSION) throw new Error('SDK_CHANGED');
  if(mode==='plan') {console.log(JSON.stringify({registration,limits:COMPACT_LIMITS,paidRequests:0},null,2));return;}
  if(existsSync('.env')) process.loadEnvFile('.env');
  const key=process.env.OPENAI_API_KEY?.trim()??'';
  if(!key) throw new Error('MISSING_OPENAI_API_KEY');
  if((process.env.TRACER_MODEL?.trim()||DEFAULT_MODEL)!==DEFAULT_MODEL) throw new Error('MODEL_CHANGED');
  const directory=join('evidence/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${COMPACT_PROTOCOL}-${randomUUID().slice(0,8)}`);
  claimCompactStudy('evidence',directory);
  const evidence=new Evidence(directory,[key]);
  evidence.write('manifest.json',{...registration,limits:COMPACT_LIMITS,node:process.version,sdk,
    pnpmUserAgent:process.env.npm_config_user_agent??null,gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sources:compactSources.map(path=>({path,sha256:sha256(readFileSync(path))})),lockfileSha256:sha256(readFileSync('pnpm-lock.yaml')),
    modelRequested:DEFAULT_MODEL,apiKeyPresent:true,studyScope:'Responses only; new USD 2 allowance',
    overshootAccepted:true,priorStudiesExcluded:true});
  const client=new OpenAI({apiKey:key,maxRetries:0,timeout:COMPACT_LIMITS.deadlineMs,fetch:compactFetch(fetch),
    ...(process.env.OPENAI_PROJECT_ID?{project:process.env.OPENAI_PROJECT_ID}:{})});
  const result=await runCompactStudy(client,evidence,new CompactBudget(),COMPACT_LIMITS.pairs,[key]);
  console.log(JSON.stringify({event:'study-completed',directory,outcome:result.outcome,budget:result.budget,error:result.error}));
  if(result.error) process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
