import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type ContextKind = 'input' | 'tool_result' | 'item' | 'event' | 'turn' | 'coverage' | 'note';
export interface ContextEntry {
  key:string; kind:ContextKind; sessionId:string|null; turnId:string|null;
  scope:string; text:string; data:Json; complete:boolean;
}
export interface ContextRecord extends ContextEntry {
  sequence:number; firstSequence:number; revision:number; recordedAt:string; previous:string; hash:string;
}
export interface SearchOptions {
  query:string; after?:number; limit?:number; sessionId?:string; turnId?:string;
  includeProvisional?:boolean; history?:boolean;
}
export interface ContextManager {
  readonly conversationId:string;
  record(entry:ContextEntry, options?:{immutable?:boolean}):ContextRecord;
  records():ContextRecord[];
  latest(key:string):ContextRecord|undefined;
  search(options:SearchOptions):{matches:{sequence:number;key:string;kind:ContextKind;turnId:string|null;sessionId:string|null;complete:boolean;excerpt:string}[];next:number|null};
  read(sequence:number, offset?:number, length?:number):{record:Omit<ContextRecord,'data'|'text'>;text:string;next:number|null;totalCharacters:number};
  checkpoint():void;
  save(destination:string):void;
  close():void;
}
const ZERO='0'.repeat(64), SCHEMA='tracer-context-v1';
export const CONTEXT_LIMITS={journalBytes:256*1024*1024,recordBytes:2*1024*1024,searchResults:20,readCharacters:16000} as const;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  throw new Error('CONTEXT_NON_JSON_VALUE');
}
function validate(entry:ContextEntry) {
  if(!entry||typeof entry.key!=='string'||!entry.key||entry.key.length>2048||
    !['input','tool_result','item','event','turn','coverage','note'].includes(entry.kind)||
    !(entry.sessionId===null||typeof entry.sessionId==='string')||!(entry.turnId===null||typeof entry.turnId==='string')||
    typeof entry.scope!=='string'||typeof entry.text!=='string'||typeof entry.complete!=='boolean')throw new Error('CONTEXT_INVALID_ENTRY');
  canonical(entry.data);
}
function entryOf(r:ContextEntry):ContextEntry {
  return {key:r.key,kind:r.kind,sessionId:r.sessionId,turnId:r.turnId,scope:r.scope,text:r.text,data:r.data,complete:r.complete};
}
function verify(rows:ContextRecord[]) {
  let previous=ZERO;const latest=new Map<string,ContextRecord>();
  for(const [sequence,r]of rows.entries()) {
    validate(r);const old=latest.get(r.key),{hash:saved,...body}=r;
    if(r.sequence!==sequence||r.previous!==previous||r.firstSequence!==(old?.firstSequence??sequence)||r.revision!==(old?old.revision+1:0)||
      typeof r.recordedAt!=='string'||hash(canonical(body))!==saved)throw new Error('CONTEXT_INTEGRITY_FAILED');
    previous=saved;latest.set(r.key,r);
  }
  return latest;
}
function atomicWrite(path:string, content:string, replace=false) {
  const temporary=join(dirname(path),`.context-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary,content,{flag:'wx',mode:0o600,flush:true});
    if(replace)renameSync(temporary,path);
    else {linkSync(temporary,path);unlinkSync(temporary);}
  } finally {if(existsSync(temporary))unlinkSync(temporary);}
}
/** Append-only authoritative JSONL; context.txt is a rebuildable grep-friendly projection.
 * One writer per directory. No provider imports, network calls, summarization or eviction.
 */
export class FileContext implements ContextManager {
  private rows:ContextRecord[]=[];
  private current=new Map<string,ContextRecord>();
  private fd:number|null=null;
  private closed=false;
  private size=0;
  private constructor(readonly directory:string, readonly conversationId:string, readonly createdAt:string, readonly writable:boolean) {}
  static create(directory:string, conversationId=randomUUID()):FileContext {
    if(!conversationId||typeof conversationId!=='string')throw new Error('CONTEXT_INVALID_ID');
    const path=resolve(directory);mkdirSync(dirname(path),{recursive:true});mkdirSync(path,{mode:0o700});
    writeFileSync(join(path,'manifest.json'),JSON.stringify({schema:SCHEMA,conversationId,createdAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600,flush:true});
    writeFileSync(join(path,'journal.jsonl'),'',{flag:'wx',mode:0o600,flush:true});
    return FileContext.open(path);
  }
  static open(directory:string, options:{readOnly?:boolean;recoverTail?:boolean}={}):FileContext {
    const path=resolve(directory),manifest=JSON.parse(readFileSync(join(path,'manifest.json'),'utf8'));
    if(manifest.schema!==SCHEMA||typeof manifest.conversationId!=='string'||typeof manifest.createdAt!=='string')throw new Error('CONTEXT_INVALID_MANIFEST');
    const store=new FileContext(path,manifest.conversationId,manifest.createdAt,!options.readOnly);
    let lock=false;
    try {
      if(store.writable) {writeFileSync(join(path,'.writer.lock'),JSON.stringify({pid:process.pid,openedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});lock=true;}
      const journal=join(path,'journal.jsonl');if(statSync(journal).size>CONTEXT_LIMITS.journalBytes)throw new Error('CONTEXT_JOURNAL_CAP');
      const bytes=readFileSync(journal),end=bytes.lastIndexOf(10)+1,tail=bytes.subarray(end);
      const lines=bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean);
      store.rows=lines.map(line=>JSON.parse(line) as ContextRecord);store.current=verify(store.rows);
      if(tail.length) {
        if(!store.writable||!options.recoverTail)throw new Error('CONTEXT_INCOMPLETE_TAIL');
        // Preserve uncommitted bytes before repairing only the final partial line.
        writeFileSync(join(path,`recovered-tail-${randomUUID()}.bin`),tail,{flag:'wx',mode:0o600,flush:true});
        truncateSync(journal,end);
      }
      store.size=end;
      if(store.writable) {store.fd=openSync(journal,'a');fsyncSync(store.fd);store.checkpoint();}
      return store;
    } catch(error) {if(store.fd!==null)closeSync(store.fd);if(lock)unlinkSync(join(path,'.writer.lock'));throw error;}
  }
  static load(snapshot:string, directory:string):FileContext {
    if(statSync(snapshot).size>CONTEXT_LIMITS.journalBytes+1024*1024)throw new Error('CONTEXT_SNAPSHOT_CAP');
    const saved=JSON.parse(readFileSync(snapshot,'utf8'));
    if(saved.schema!==SCHEMA||typeof saved.conversationId!=='string'||typeof saved.createdAt!=='string'||!Array.isArray(saved.records))throw new Error('CONTEXT_INVALID_SNAPSHOT');
    verify(saved.records);
    if(saved.head!==(saved.records.at(-1)?.hash??ZERO)||saved.checksum!==hash(canonical({schema:SCHEMA,conversationId:saved.conversationId,createdAt:saved.createdAt,records:saved.records,head:saved.head})))throw new Error('CONTEXT_INVALID_SNAPSHOT');
    const journal=saved.records.map((r:ContextRecord)=>JSON.stringify(r)+'\n').join('');
    if(Buffer.byteLength(journal)>CONTEXT_LIMITS.journalBytes)throw new Error('CONTEXT_JOURNAL_CAP');
    const path=resolve(directory);mkdirSync(dirname(path),{recursive:true});mkdirSync(path,{mode:0o700});
    writeFileSync(join(path,'manifest.json'),JSON.stringify({schema:SCHEMA,conversationId:saved.conversationId,createdAt:saved.createdAt})+'\n',{flag:'wx',mode:0o600,flush:true});
    writeFileSync(join(path,'journal.jsonl'),journal,{flag:'wx',mode:0o600,flush:true});
    return FileContext.open(path);
  }
  private active(write=false) {
    if(this.closed)throw new Error('CONTEXT_CLOSED');if(write&&!this.writable)throw new Error('CONTEXT_READ_ONLY');
  }
  record(entry:ContextEntry, options:{immutable?:boolean}={}):ContextRecord {
    this.active(true);validate(entry);
    const data=JSON.parse(canonical(entryOf(entry))) as ContextEntry,old=this.current.get(data.key);
    if(old&&canonical(entryOf(old))===canonical(data))return structuredClone(old);
    if(old&&options.immutable)throw new Error('CONTEXT_CHANGED_DUPLICATE');
    const body={...data,sequence:this.rows.length,firstSequence:old?.firstSequence??this.rows.length,revision:old?old.revision+1:0,
      recordedAt:new Date().toISOString(),previous:this.rows.at(-1)?.hash??ZERO};
    const row={...body,hash:hash(canonical(body))},line=JSON.stringify(row)+'\n',bytes=Buffer.byteLength(line);
    if(bytes>CONTEXT_LIMITS.recordBytes)throw new Error('CONTEXT_RECORD_CAP');
    if(this.size+bytes>CONTEXT_LIMITS.journalBytes)throw new Error('CONTEXT_JOURNAL_CAP');
    // Update in-memory state only after the complete append has been flushed.
    try {writeFileSync(this.fd!,line);fsyncSync(this.fd!);}
    catch(error) {this.closed=true;closeSync(this.fd!);this.fd=null;unlinkSync(join(this.directory,'.writer.lock'));throw error;}
    this.size+=bytes;this.rows.push(row);this.current.set(row.key,row);return structuredClone(row);
  }
  records() {this.active();return structuredClone(this.rows);}
  latest(key:string) {this.active();const row=this.current.get(key);return row?structuredClone(row):undefined;}
  search(options:SearchOptions) {
    this.active();const {query,after=-1,limit=10}=options;
    if(typeof query!=='string'||!query||query.length>512||!Number.isInteger(after)||after< -1||!Number.isInteger(limit)||limit<1||limit>CONTEXT_LIMITS.searchResults)throw new Error('CONTEXT_INVALID_SEARCH');
    const candidates=(options.history!==false?[...this.rows]:[...this.current.values()]).sort((a,b)=>a.sequence-b.sequence);
    const matches=[];let next:number|null=null;
    for(const r of candidates) {
      if(r.sequence<=after||!['input','tool_result','item','note'].includes(r.kind)||(!r.complete&&!options.includeProvisional)||
        (options.sessionId!==undefined&&r.sessionId!==options.sessionId)||(options.turnId!==undefined&&r.turnId!==options.turnId))continue;
      const at=r.text.indexOf(query);if(at<0)continue;
      if(matches.length===limit){next=matches.at(-1)!.sequence;break;}
      matches.push({sequence:r.sequence,key:r.key,kind:r.kind,turnId:r.turnId,sessionId:r.sessionId,complete:r.complete,excerpt:r.text.slice(Math.max(0,at-80),at+query.length+160)});
    }
    return {matches,next};
  }
  read(sequence:number, offset=0, length=8000) {
    this.active();if(!Number.isInteger(sequence)||sequence<0||!Number.isInteger(offset)||offset<0||!Number.isInteger(length)||length<1||length>CONTEXT_LIMITS.readCharacters)throw new Error('CONTEXT_INVALID_READ');
    const row=this.rows[sequence];if(!row)throw new Error('CONTEXT_RECORD_NOT_FOUND');
    const {data:_,text,...record}=structuredClone(row);
    return {record,text:text.slice(offset,offset+length),next:offset+length<text.length?offset+length:null,totalCharacters:text.length};
  }
  checkpoint() {
    this.active(true);fsyncSync(this.fd!);
    const lines=[`Conversation ${JSON.stringify(this.conversationId)} — captured records, not the model's hidden working context.`,
      `Journal head: ${this.rows.at(-1)?.hash??ZERO}. Capture order; provisional records are labeled.`, ''];
    for(const r of this.rows) {
      if(!['input','tool_result','item','note','coverage'].includes(r.kind))continue;
      if((!r.complete||r.kind==='coverage')&&this.current.get(r.key)?.sequence!==r.sequence)continue;
      lines.push(`[record ${r.sequence} | revision ${r.revision} | ${r.complete?'captured':'PROVISIONAL'} | ${r.kind} | session=${JSON.stringify(r.sessionId)} | turn=${JSON.stringify(r.turnId)} | key=${JSON.stringify(r.key)}]`);
      // Prefix content lines so archived text cannot forge a structural record header.
      for(const line of r.text.split('\n'))lines.push('| '+line);
      lines.push('');
    }
    atomicWrite(join(this.directory,'context.txt'),lines.join('\n')+'\n',true);
  }
  save(destination:string) {
    this.active();if(this.writable)this.checkpoint();
    const body={schema:SCHEMA,conversationId:this.conversationId,createdAt:this.createdAt,records:this.rows,head:this.rows.at(-1)?.hash??ZERO};
    atomicWrite(resolve(destination),JSON.stringify({...body,checksum:hash(canonical(body))})+'\n');
  }
  close() {
    if(this.closed)return;
    try {if(this.writable)this.checkpoint();}
    finally {this.closed=true;if(this.fd!==null)closeSync(this.fd);this.fd=null;if(this.writable)unlinkSync(join(this.directory,'.writer.lock'));}
  }
}
