import {Evidence} from './evidence.js';
import {sha256} from './protocol.js';

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
