import {Evidence,safeError} from './evidence.js';
import {setTimeout as delay} from 'node:timers/promises';
import {sha256} from './protocol.js';

// Put this outside boundedFetch: every actual attempt must traverse its counter.
export function readOnlyRetryFetch(base:typeof fetch,evidence:Evidence,wait:(ms:number)=>Promise<unknown>=delay):typeof fetch {
  return async(input,init)=>{
    const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    if(method!=='GET') return base(input,init);
    const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
    const signal=init?.signal??(input instanceof Request?input.signal:null);
    for(let attempt=0;;attempt++) {
      let response:Response;
      try {response=await base(input,init);}
      catch(error) {
        // Native fetch reports network failures as TypeError. Local budget errors and aborts are terminal.
        if(!(error instanceof TypeError)||signal?.aborted||attempt>=2) throw error;
        evidence.record('http.read-only-retry',{path,attempt:attempt+1,error:safeError(error)});
        await wait(500*(attempt+1));continue;
      }
      if(attempt>=2||signal?.aborted||!(response.status===408||response.status===429||response.status>=500)) return response;
      evidence.record('http.read-only-retry',{path,attempt:attempt+1,status:response.status,requestId:response.headers.get('x-request-id')});
      await response.body?.cancel();await wait(500*(attempt+1));
    }
  };
}

// Added after v9 stopped. Capture the wire result before SDK convenience parsing can throw.
// This does not retry, change a model request, settle a bill, or reopen a dispatch claim.
export function captureResponses(base:typeof fetch,evidence:Evidence):typeof fetch {
  let index=0;
  return async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(!/\/responses(?:\/compact)?$/.test(url.pathname)) return base(input,init);
    const id=String(++index).padStart(3,'0');
    const response=await base(input,init);
    const metadata={path:url.pathname,status:response.status,requestId:response.headers.get('x-request-id'),
      contentType:response.headers.get('content-type'),capturedBeforeSDKParsing:true};
    const reader=response.body?.getReader();if(!reader) {evidence.write(`http-${id}.json`,{...metadata,body:null});return response;}
    const chunks:Uint8Array[]=[];let bytes=0;
    try {
      while(true) {
        const next=await reader.read();if(next.done) break;
        bytes+=next.value.byteLength;
        if(bytes>2*1024*1024) {await reader.cancel();throw new Error('RESPONSE_BODY_CAP');}
        chunks.push(next.value);
      }
    } catch(error) {
      evidence.write(`http-${id}.json`,{...metadata,complete:false,bytesRead:bytes,bodyHash:sha256(Buffer.concat(chunks))});throw error;
    } finally {reader.releaseLock();}
    const body=Buffer.concat(chunks);
    evidence.write(`http-${id}.json`,{...metadata,complete:true,bytes,bodyHash:sha256(body),body:body.toString('utf8')});
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
