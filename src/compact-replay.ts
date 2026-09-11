import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyLog} from './evidence.js';
import {sha256} from './protocol.js';
import {compactBoundary,classifyCompact,COMPACT_INSTRUCTIONS,type CompactArmResult} from './compact-protocol.js';
import type {CompactedResponse} from 'openai/resources/responses/responses';

const directory=resolve(process.argv[2]??'');
if(process.argv.length!==3) throw new Error('Usage: pnpm compact-replay <run-directory>');
const read=(path:string)=>JSON.parse(readFileSync(join(directory,path),'utf8'));
const check=(value:unknown,label:string)=>{if(!value)throw new Error(`REPLAY_FAILED:${label}`);};
const manifest=read('manifest.json'),result=read('result.json');
check(manifest.protocol==='responses-compact-v7','protocol');
check(sha256(readFileSync('research/11-responses-compaction-protocol.md'))===manifest.protocolHash,'protocol hash');
for(const source of manifest.sources) {
  const bytes=execFileSync('git',['show',`${manifest.gitCommit}:${source.path}`]);
  check(sha256(bytes)===source.sha256,`committed source ${source.path}`);
}
let logCount=0,recordCount=0;
function logs(path:string) {
  for(const item of readdirSync(path,{withFileTypes:true})) {
    const next=join(path,item.name);if(item.isDirectory())logs(next);
    else if(item.name==='events.jsonl'){recordCount+=verifyLog(next);logCount++;}
  }
}
logs(directory);
const pairs=[];
for(const summary of result.summaries) {
  const base=`pair-${summary.pair}`,fixture=read(`${base}/fixture.json`),state=read(`${base}/external-state.json`);
  check(sha256(readFileSync(join(directory,base,'external-state.json')))===fixture.state.expectedSha256,'external file hash');
  check(state.handle===fixture.handle,'fixture handle');
  const compacted:CompactedResponse=read(`${base}/compact-response.json`);
  const boundary=compactBoundary(compacted,state.handle);
  check(JSON.stringify(boundary)===JSON.stringify(summary.boundary),'boundary derivation');
  const history=read(`${base}/history.json`),compactRequest=read(`${base}/compact-request.json`),query=read(`${base}/query.json`);
  check(JSON.stringify(compactRequest.input)===JSON.stringify(history.input),'full history compacted');
  check(sha256(JSON.stringify(history.input))===history.sha256,'history hash');
  check(query.afterCompactId===compacted.id,'query names compact result');
  const events=readFileSync(join(directory,base,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const completed=events.find(e=>e.kind==='request.completed'&&e.data.name==='compact');
  check(completed && query.selectedAt>=completed.at,'query selected after compact returned');
  check(!query.query.includes(state.handle) && !COMPACT_INSTRUCTIONS.includes(state.handle),'locator not refreshed');
  check(!state.records.some((r:{value:string})=>JSON.stringify(history.input).includes(r.value)),'external values absent from setup');
  const arms:Record<string,CompactArmResult>={};
  for(const arm of ['control','treatment']) {
    const request=read(`${base}/${arm}/read-request.json`),response=read(`${base}/${arm}/read-response.json`);
    const prefix=arm==='control'?history.input:compacted.output;
    check(JSON.stringify(request.input.slice(0,-1))===JSON.stringify(prefix),`${arm} exclusive prefix`);
    check(request.input.at(-1).content===query.query,`${arm} query`);
    check(request.store===false && request.background===false && !request.previous_response_id && !request.conversation,`${arm} stateless`);
    check(request.instructions===COMPACT_INSTRUCTIONS,`${arm} instructions`);
    const saved=read(`${base}/${arm}/result.json`) as CompactArmResult;
    if(saved.readStatus==='valid') {
      const calls=response.output.filter((i:{type:string})=>i.type==='function_call');
      check(response.status==='completed'&&calls.length===1&&calls[0].name==='tracer_state_read',`${arm} read call`);
      const args=JSON.parse(calls[0].arguments);
      check(args.handle===state.handle&&JSON.stringify(args.indices)===JSON.stringify(query.indices),`${arm} read arguments`);
      const returned=read(`${base}/${arm}/read-result.json`);
      const wanted=query.indices.map((i:number)=>state.records[i]);
      check(returned.output===JSON.stringify({records:wanted})&&returned.callId===calls[0].call_id,`${arm} exact tool return`);
      const submitRequest=read(`${base}/${arm}/submit-request.json`),submitResponse=read(`${base}/${arm}/submit-response.json`);
      check(submitRequest.input.at(-1).output===returned.output,`${arm} tool result delivered`);
      const submitCalls=submitResponse.output.filter((i:{type:string})=>i.type==='function_call');
      if(saved.submissionCorrect===true) {
        check(submitResponse.status==='completed'&&submitCalls.length===1&&submitCalls[0].name==='tracer_state_submit',`${arm} submit call`);
        const payload=JSON.parse(submitCalls[0].arguments);
        check(Array.isArray(payload.records)&&payload.records.length===2&&wanted.every((w:{index:number;value:string})=>
          payload.records.filter((r:{index:number;value:string})=>r.index===w.index&&r.value===w.value).length===1),`${arm} exact submission`);
      }
    }
    arms[arm]=saved;
  }
  const classification=classifyCompact(arms.control!,arms.treatment!,boundary,true);
  check(JSON.stringify(classification)===JSON.stringify(summary.classification),'classification');
  pairs.push({pair:summary.pair,boundary,control:arms.control,treatment:arms.treatment,classification});
}
const audit={protocol:manifest.protocol,reviewedAt:new Date().toISOString(),readOnly:true,paidRequests:0,
  manifestSha256:sha256(readFileSync(join(directory,'manifest.json'))),resultSha256:sha256(readFileSync(join(directory,'result.json'))),
  protocolHash:manifest.protocolHash,sourceCommit:manifest.gitCommit,logsVerified:logCount,recordsVerified:recordCount,pairs,
  note:'Replay checks artifact consistency and observed service items. It does not decrypt compact state or establish managed Agents behavior.'};
const output=existsSync(join(directory,'replay.json'))?`replay-${new Date().toISOString().replace(/[:.]/g,'-')}.json`:'replay.json';
writeFileSync(join(directory,output),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(audit,null,2));
