// Offline verification only. Uses recorded service data; never creates or resumes a session.
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentSessionItem} from 'openai/resources/beta/agents/agents';
import {FileContext,AgentsContext,contextTools} from './index.js';
import {importEvidence} from './import-evidence.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function main() {
  const [source,destination,...extra]=process.argv.slice(2);
  if(!source||!destination||extra.length)throw new Error('Usage: pnpm context-demo EVENTS_JSONL NEW_DIRECTORY (offline only)');
  mkdirSync(destination); // Refuse reuse, including an earlier failed attempt.
  const imported=importEvidence(source,join(destination,'original'));
  const original=FileContext.open(join(destination,'original'));
  let reference,originalRows;
  try {
    originalRows=original.records();
    reference=originalRows.find(r=>r.kind==='item'&&r.complete&&(r.data as {type?:string;role?:string}).type==='message'&&(r.data as {role?:string}).role==='user');
    if(!reference)throw new Error('CONTEXT_DEMO_NO_USER_MESSAGE');
    original.save(join(destination,'snapshot.json'));
  } finally {original.close();}
  const restored=FileContext.load(join(destination,'snapshot.json'),join(destination,'restored'));
  const empty=FileContext.create(join(destination,'negative-control'));
  try {
    const roundtrip=JSON.stringify(restored.records())===JSON.stringify(originalRows);
    const workingHistory:AgentSessionItem[]=[{id:'synthetic-recent-only',turn_id:'synthetic-later-turn',type:'message',role:'user',phase:null,
      status:'completed',content:[{type:'input_text',text:'Continue the earlier task. Use archived details if needed.'}]}];
    const query=reference.text.slice(0,Math.min(reference.text.length,100));
    // A shorter *simulated* server history does not evict already captured records.
    const adapter=new AgentsContext(restored,imported.sessionId);adapter.captureItems(workingHistory);adapter.checkpoint();
    const tools=contextTools(restored,imported.sessionId);
    const searchAction={type:'function_call' as const,turn_id:'offline-verification',call_id:'lookup',name:'context_search',arguments:{query}};
    const searchOutput=tools.handle(imported.sessionId,searchAction),search=JSON.parse(searchOutput);
    const match=search.result.matches.find((m:{sequence:number})=>m.sequence===reference.sequence);
    if(!match)throw new Error('CONTEXT_DEMO_LOOKUP_FAILED');
    let recovered='',offset=0,maxReplyBytes=Buffer.byteLength(searchOutput),calls=0;
    for(;;) {
      if(++calls>100)throw new Error('CONTEXT_DEMO_READ_CAP');
      const output=tools.handle(imported.sessionId,{type:'function_call',turn_id:'offline-verification',call_id:`read-${calls}`,
        name:'context_read',arguments:{sequence:match.sequence,offset,length:2000}});
      maxReplyBytes=Math.max(maxReplyBytes,Buffer.byteLength(output));const read=JSON.parse(output).result;
      recovered+=read.text;if(read.next===null)break;offset=read.next;
    }
    const emptyResult=JSON.parse(contextTools(empty,imported.sessionId).handle(imported.sessionId,searchAction));
    const checks={snapshotRoundtripExact:roundtrip,oldTextAbsentFromSimulatedWorkingHistory:!JSON.stringify(workingHistory).includes(query),
      earlierItemRetainedAfterShorterSimulatedHistory:!!match,toolReadExact:recovered===reference.text,
      emptyArchiveReturnsNoMatches:emptyResult.result.matches.length===0,repliesWithin24KB:maxReplyBytes<=24000};
    if(!Object.values(checks).every(Boolean))throw new Error('CONTEXT_DEMO_VERIFICATION_FAILED');
    const receipt={schema:'tracer-context-verification-v1',recordedAt:new Date().toISOString(),mode:'offline-replay-and-synthetic-control',
      source:source.replaceAll('\\','/'),import:imported,node:process.version,pnpm:JSON.parse(readFileSync('package.json','utf8')).packageManager,
      sdk:JSON.parse(readFileSync('node_modules/openai/package.json','utf8')).version,
      reference:{sequence:reference.sequence,key:reference.key,textCharacters:reference.text.length,textSha256:sha(reference.text),query},
      recoveredSha256:sha(recovered),searchMatchCount:search.result.matches.length,readCalls:calls,maxReplyBytes,checks,
      newApiCalls:0,newPaidInferenceUsd:0,liveModelRetrievalTest:false,managedCompactionEstablished:false};
    writeFileSync(join(destination,'verification.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(receipt,null,2));
  } finally {restored.close();empty.close();}
}
try {main();}catch(error){console.error(error instanceof Error?error.message:'CONTEXT_DEMO_FAILED');process.exitCode=1;}
