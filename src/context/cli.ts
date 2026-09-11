import {readFileSync} from 'node:fs';
import {FileContext,type ContextEntry} from './store.js';
import {importEvidence} from './import-evidence.js';

const help=`Offline conversation archive (no API key or network calls):
  pnpm context init DIRECTORY
  pnpm context append DIRECTORY ENTRY_JSON_FILE
  pnpm context search DIRECTORY "literal phrase" [AFTER_SEQUENCE]
  pnpm context read DIRECTORY SEQUENCE [OFFSET]
  pnpm context status DIRECTORY
  pnpm context save DIRECTORY SNAPSHOT_JSON
  pnpm context load SNAPSHOT_JSON NEW_DIRECTORY
  pnpm context import-log EVENTS_JSONL NEW_DIRECTORY
Use .tracer/context/... for private local data (git-ignored). Creation and export refuse to overwrite.`;

function main(args:string[]) {
  const [command,first,second,third,...extra]=args;
  if(!command||command==='--help'){console.log(help);return;}
  const lengths:Record<string,number[]>={init:[2],append:[3],search:[3,4],read:[3,4],status:[2],save:[3],load:[3],'import-log':[3]};
  if(!lengths[command]?.includes(args.length)||!first||extra.length)throw new Error(help);
  if(command==='import-log'){console.log(JSON.stringify(importEvidence(first,second!),null,2));return;}
  if(command==='init'||command==='load') {
    const store=command==='init'?FileContext.create(first):FileContext.load(first,second!);
    try {console.log(JSON.stringify({conversationId:store.conversationId,directory:store.directory}));}finally{store.close();}
    return;
  }
  const store=FileContext.open(first,{readOnly:command!=='append'});
  try {
    let result:unknown;
    if(command==='append')result=store.record(JSON.parse(readFileSync(second!,'utf8')) as ContextEntry);
    else if(command==='search')result=store.search({query:second!,...(third!==undefined?{after:Number(third)}:{})});
    else if(command==='read')result=store.read(Number(second),third===undefined?0:Number(third));
    else if(command==='save'){store.save(second!);result={saved:second,conversationId:store.conversationId};}
    else {
      const rows=store.records();result={conversationId:store.conversationId,records:rows.length,head:rows.at(-1)?.hash??null,
        coverage:rows.filter(r=>r.kind==='coverage').map(r=>({sequence:r.sequence,complete:r.complete,data:r.data}))};
    }
    console.log(JSON.stringify(result,null,2));
  } finally {store.close();}
}
try {main(process.argv.slice(2));}
catch(error) {console.error(error instanceof Error?error.message:'CONTEXT_COMMAND_FAILED');process.exitCode=1;}
