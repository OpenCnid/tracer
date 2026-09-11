// Offline migration of an existing tracer transcript. This module makes no API calls.
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {AgentSessionEvent,AgentSessionItem} from 'openai/resources/beta/agents/agents';
import {FileContext,CONTEXT_LIMITS} from './store.js';
import {AgentsContext} from './agents.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export function importEvidence(source:string,destination:string) {
  if(statSync(source).size>CONTEXT_LIMITS.journalBytes)throw new Error('CONTEXT_IMPORT_CAP');
  const text=readFileSync(source,'utf8');
  if(!text.endsWith('\n'))throw new Error('CONTEXT_IMPORT_INCOMPLETE');
  const rows=text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  let previous='0'.repeat(64),sequence=0;
  const sessions=new Set<string>();
  for(const row of rows) {
    const {hash,...body}=row;
    if(body.previous!==previous||body.sequence!==sequence++||hash!==sha(JSON.stringify(body)))throw new Error('CONTEXT_IMPORT_INVALID_CHAIN');
    previous=hash;
    const id=row.kind==='sse'?(row.data.session_id??row.data.session?.id):row.kind==='session.snapshot'?row.data.id:null;
    if(typeof id==='string')sessions.add(id);
  }
  if(sessions.size!==1)throw new Error('CONTEXT_IMPORT_REQUIRES_ONE_SESSION');
  const sessionId=[...sessions][0]!,sourceSha256=sha(text),store=FileContext.create(destination);
  try {
    store.record({key:`import:${sourceSha256}`,kind:'note',sessionId,turnId:null,scope:'application',complete:true,
      text:'Offline import of previously recorded public Agents data. Journal timestamps describe this import, not the original service run. This is not evidence of managed compaction.',
      data:{sourceSha256,sourceRecords:rows.length,firstObservedAt:rows[0]?.at??null,lastObservedAt:rows.at(-1)?.at??null}});
    const adapter=new AgentsContext(store,sessionId);
    let events=0,items=0;
    const ordinals=new Map<string,number>();
    for(const row of rows) {
      if(row.kind==='sse'){adapter.capture(row.data as AgentSessionEvent);events++;}
      if(row.kind==='root.items'||row.kind.startsWith('child.items:')) {
        const scope=row.kind==='root.items'?'root':`subagent:${row.kind.slice('child.items:'.length)}`;
        const list=row.data.data as AgentSessionItem[];
        if(!Array.isArray(list))throw new Error('CONTEXT_IMPORT_INVALID_ITEMS');
        if(row.data.page===0)ordinals.set(scope,0);
        const ordinal=ordinals.get(scope)??0;
        adapter.captureItems(list,scope,ordinal);ordinals.set(scope,ordinal+list.length);items+=list.length;
      }
    }
    adapter.markCoverage(false,{sourceSha256,mode:'offline-evidence-import',sourceRecords:rows.length,events,items,
      explanation:'Only records present in this source file were imported. No live enumeration or missed-event recovery was attempted.'});
    const records=store.records();
    return {mode:'offline-evidence-import',sourceSha256,sessionId,conversationId:store.conversationId,sourceRecords:rows.length,
      events,items,archiveRecords:records.length,archiveHead:records.at(-1)?.hash??null,newApiCalls:0,managedCompactionEstablished:false};
  } finally {store.close();}
}
