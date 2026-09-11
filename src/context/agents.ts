import type OpenAI from 'openai';
import type {AgentSessionEvent, AgentSessionItem} from 'openai/resources/beta/agents/agents';
import {createHash} from 'node:crypto';
import type {ContextManager, Json} from './store.js';

const json=(value:unknown):Json=>JSON.parse(JSON.stringify(value)) as Json;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal=(value:unknown)=>['completed','failed','incomplete','cancelled'].includes(String(value));
function textOf(item:Record<string,unknown>):string {
  if(item.type==='message'||item.type==='agent_message') {
    const content=Array.isArray(item.content)?item.content:[];
    const status=item.status&&item.status!=='completed'?` [${item.status}]`:'';
    return `${item.role??item.type}${item.phase?` (${item.phase})`:''}${status}:\n`+content.map(c=>typeof c?.text==='string'?c.text:JSON.stringify(c)).join('\n');
  }
  if(item.type==='reasoning')return 'Exposed reasoning summary:\n'+JSON.stringify(item.summary??[]);
  if(item.type==='function_call_output')return `Tool output ${item.call_id}:\n`+
    (typeof item.output==='string'?item.output:JSON.stringify(item.output??null,null,2))+
    (item.error?`\nTool error: ${item.error}`:'');
  return JSON.stringify(item,null,2);
}
interface Page<T> {data:T[];hasNextPage():boolean;getNextPage():Promise<Page<T>>}
/** Maps public Agents records into a provider-independent archive. Never runs inference. */
export class AgentsContext {
  private session:string|null=null;
  private readonly turnScopes=new Map<string,string>();
  private readonly partial=new Map<string,{turnId:string|null;scope:string;itemId:string;parts:Map<number,string>}>();
  constructor(readonly store:ContextManager, sessionId?:string) {
    if(sessionId)this.bindSession(sessionId);
  }
  get sessionId() {return this.session;}
  bindSession(sessionId:string) {
    if(!sessionId||this.session&&this.session!==sessionId)throw new Error('CONTEXT_SESSION_MISMATCH');
    const first=this.session===null;
    this.session=sessionId;
    this.store.record({key:`binding:${sessionId}`,kind:'note',sessionId,turnId:null,scope:'application',complete:true,
      text:`Application bound session ${sessionId} to conversation ${this.store.conversationId}.`,data:{sessionId,conversationId:this.store.conversationId}},{immutable:true});
    // Durable events reconstruct unfinished output after a local process restart.
    if(first) {
      const records=this.store.records().filter(row=>row.sessionId===sessionId);
      for(const row of records)if(row.kind==='item'&&row.turnId&&row.scope!=='unattributed')this.turnScopes.set(row.turnId,row.scope);
      const events=records.filter(row=>row.kind==='event');
      for(const row of events)this.rememberTurn(row.data as Record<string,unknown>);
      for(const row of events)this.project(row.data as Record<string,unknown>);
    }
  }
  input(requestId:string,input:unknown) {
    const old=this.store.latest(`outbound:${requestId}`);
    this.store.record({key:`outbound:${requestId}`,kind:'input',sessionId:old?old.sessionId:this.session,turnId:null,scope:'application',complete:true,
      text:`Outbound input (${requestId}); this record does not establish server acceptance.\n${typeof input==='string'?input:JSON.stringify(input,null,2)}`,data:json({requestId,input})},{immutable:true});
  }
  toolResult(turnId:string,callId:string,output:unknown) {
    if(!this.session)throw new Error('CONTEXT_SESSION_UNBOUND');
    this.store.record({key:`tool-result:${this.session}:${turnId}:${callId}`,kind:'tool_result',sessionId:this.session,turnId,scope:'application',complete:true,
      text:`Application tool result ${callId} (saved before transmission):\n${typeof output==='string'?output:JSON.stringify(output,null,2)}`,data:json({callId,output})},{immutable:true});
  }
  private key(scope:string,id:string) {return `item:${this.session}:${scope}:${id}`;}
  private item(item:Record<string,unknown>, turnId:string|null, scope:string, fallback:string) {
    if(!this.session)throw new Error('CONTEXT_SESSION_UNBOUND');
    const id=typeof item.id==='string'?item.id:fallback,key=this.key(scope,id),old=this.store.latest(key),complete=terminal(item.status);
    // Reconciliation may finish an item before a buffered partial update arrives.
    if(old?.complete&&!complete)return;
    this.store.record({key,kind:'item',sessionId:this.session,turnId,scope,text:textOf(item),data:json(item),complete});
    if(complete) {
      this.partial.delete(key);
      const unscoped=this.key('unattributed',id);
      if(scope!=='unattributed'&&(this.partial.has(unscoped)||this.store.latest(unscoped))) {
        // A missed turn event can leave early deltas without a root/child attribution.
        // Retain their journal records while replacing the unfinished projection with a reference.
        this.store.record({key:unscoped,kind:'event',sessionId:this.session,turnId,scope:'events',complete:true,
          text:`Final item available at ${key}.`,data:{supersededBy:key}});
        this.partial.delete(unscoped);
      }
    }
  }
  captureItems(items:AgentSessionItem[], scope='root', ordinal=0) {
    for(const [index,item]of items.entries()) {
      if(item.turn_id)this.turnScopes.set(item.turn_id,scope);
      this.item(item as unknown as Record<string,unknown>,item.turn_id,scope,`legacy:${ordinal+index}:${digest(item)}`);
    }
  }
  capture(event:AgentSessionEvent) {
    if(typeof event.event_id!=='string'||!event.event_id)throw new Error('CONTEXT_INVALID_EVENT_ID');
    const raw=json(event) as Record<string,Json>;
    const sessionId=typeof raw.session_id==='string'?raw.session_id:'session' in event?event.session.id:this.session;
    if(!sessionId)throw new Error('CONTEXT_EVENT_WITHOUT_SESSION');this.bindSession(sessionId);
    const key=`event:${sessionId}:${event.event_id}`,old=this.store.latest(key);
    this.store.record({key,kind:'event',sessionId,turnId:typeof raw.turn_id==='string'?raw.turn_id:null,scope:'events',
      text:typeof raw.delta==='string'?raw.delta:'',data:raw,complete:true},{immutable:true});
    if(old)return; // Replayed event IDs do not append the same delta twice.
    this.project(raw);
    if(event.type==='agent.session.turn.item.done') {
      const turnId=event.turn_id,scope=turnId?this.turnScopes.get(turnId)??'unattributed':'unattributed';
      this.item(event.item as unknown as Record<string,unknown>,turnId,scope,`event:${event.event_id}`);
    }
    if('turn' in event) {
      this.store.record({key:`turn:${sessionId}:${event.turn.id}`,kind:'turn',sessionId,turnId:event.turn.id,scope:event.turn.subagent_id?`subagent:${event.turn.subagent_id}`:'root',
        text:`Turn ${event.turn.id}: ${event.turn.status}`,data:json(event.turn),complete:terminal(event.turn.status)});
      if(terminal(event.turn.status))this.checkpoint();
    }
  }
  private rememberTurn(raw:Record<string,unknown>) {
    const turn=raw.turn as {id?:string;subagent_id?:string|null}|undefined;
    if(turn?.id)this.turnScopes.set(turn.id,turn.subagent_id?`subagent:${turn.subagent_id}`:'root');
  }
  private project(raw:Record<string,unknown>) {
    this.rememberTurn(raw);
    if(raw.type!=='agent.session.turn.output_text.delta'||typeof raw.item_id!=='string'||typeof raw.delta!=='string')return;
    const turnId=typeof raw.turn_id==='string'?raw.turn_id:null,scope=turnId?this.turnScopes.get(turnId)??'unattributed':'unattributed';
    const key=this.key(scope,raw.item_id);if(this.store.latest(key)?.complete)return;
    const pending=this.partial.get(key)??{turnId,scope,itemId:raw.item_id,parts:new Map<number,string>()};
    const part=Number(raw.content_index??0);pending.parts.set(part,(pending.parts.get(part)??'')+raw.delta);this.partial.set(key,pending);
  }
  checkpoint() {
    for(const [key,p]of this.partial) {
      if(this.store.latest(key)?.complete)continue;
      const text=[...p.parts].sort(([a],[b])=>a-b).map(([,text])=>text).join('\n');
      this.store.record({key,kind:'item',sessionId:this.session,turnId:p.turnId,scope:p.scope,text:`assistant (unfinished stream):\n${text}`,
        data:{itemId:p.itemId,provisional:true},complete:false});
    }
    this.store.checkpoint();
  }
  markCoverage(complete:boolean, details:Json) {
    if(!this.session)throw new Error('CONTEXT_SESSION_UNBOUND');
    this.store.record({key:`coverage:${this.session}`,kind:'coverage',sessionId:this.session,turnId:null,scope:'application',complete,
      text:complete?'Available public item histories enumerated. Hidden context and missed stream events are not certified.':'Public history reconciliation incomplete; captured records remain available.',data:details});
    this.checkpoint();
  }
  async reconcile(client:OpenAI, options:{signal?:AbortSignal;maxPages?:number;maxSubagents?:number}={}) {
    if(!this.session)throw new Error('CONTEXT_SESSION_UNBOUND');
    const id=this.session,maxPages=options.maxPages??50,maxSubagents=options.maxSubagents??16;
    if(!Number.isInteger(maxPages)||maxPages<1||maxPages>100||!Number.isInteger(maxSubagents)||maxSubagents<0||maxSubagents>100)throw new Error('CONTEXT_INVALID_RECONCILE_LIMIT');
    const opts={timeout:30000,maxRetries:0,...(options.signal?{signal:options.signal}:{})};
    const startedAt=new Date().toISOString();let pages=0,items=0;
    this.markCoverage(false,{startedAt});
    const enumerate=async<T>(first:PromiseLike<Page<T>>,consume:(rows:T[],ordinal:number)=>void)=>{
      let page=await first,ordinal=0;
      for(;;) {
        if(++pages>maxPages)throw new Error('CONTEXT_PAGE_CAP');consume(page.data,ordinal);ordinal+=page.data.length;
        if(!page.hasNextPage())return;
        if(pages>=maxPages)throw new Error('CONTEXT_PAGE_CAP');page=await page.getNextPage();
      }
    };
    try {
      const capture=(scope:string)=>(rows:AgentSessionItem[],ordinal:number)=>{this.captureItems(rows,scope,ordinal);items+=rows.length;};
      await enumerate(client.beta.agents.sessions.items.list(id,{order:'asc',limit:100},opts),capture('root'));
      const children:string[]=[];
      if(pages>=maxPages)throw new Error('CONTEXT_PAGE_CAP');
      await enumerate(client.beta.agents.sessions.subagents.list(id,{order:'asc',limit:100},opts),rows=>{
        for(const child of rows){if(children.length>=maxSubagents)throw new Error('CONTEXT_SUBAGENT_CAP');children.push(child.id);}
      });
      for(const child of children) {
        if(pages>=maxPages)throw new Error('CONTEXT_PAGE_CAP');
        await enumerate(client.beta.agents.sessions.subagents.items.list(child,{session_id:id,order:'asc',limit:100},opts),capture(`subagent:${child}`));
      }
      const session=await client.beta.agents.sessions.retrieve(id,opts);
      const result={startedAt,finishedAt:new Date().toISOString(),pages,items,subagents:children,status:session.status,
        enumerationComplete:true,pointInTimeSnapshot:false,hiddenContextCaptured:false,missedEventsRecovered:false};
      this.markCoverage(true,result);return result;
    } catch(error) {
      this.markCoverage(false,{startedAt,pages,items,error:error instanceof Error?error.name:'UnknownError',
        reason:error instanceof Error&&/^CONTEXT_[A-Z_]+$/.test(error.message)?error.message:null});throw error;
    }
  }
}
