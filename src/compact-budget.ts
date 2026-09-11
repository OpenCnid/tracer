import {COMPACT_LIMITS} from './compact-protocol.js';
import {GUARD_RATES} from './budget.js';

export class CompactBudget {
  readonly calls: {name: string; reservationUsd: number; estimateUsd: number|null; usage: {input_tokens:number;output_tokens:number}|null}[] = [];
  reserve(name: string, compact: boolean) {
    if (this.calls.some(c => c.usage === null)) throw new Error('UNSETTLED_REQUEST');
    const reservationUsd = compact ? COMPACT_LIMITS.compactReservationUsd : COMPACT_LIMITS.responseReservationUsd;
    if (this.calls.length >= COMPACT_LIMITS.requests) throw new Error('REQUEST_CAP');
    if (this.snapshot().admissionEstimateUsd + reservationUsd > COMPACT_LIMITS.studyUsd) throw new Error('STUDY_ADMISSION_CAP');
    this.calls.push({name, reservationUsd, estimateUsd:null, usage:null});
  }
  settle(usage: {input_tokens:number;output_tokens:number}|null|undefined) {
    const last = this.calls.at(-1);
    if (!last || last.usage) throw new Error('INVALID_SETTLEMENT');
    if (!usage || ![usage.input_tokens,usage.output_tokens].every(n=>Number.isSafeInteger(n)&&n>=0))
      throw new Error('MISSING_OR_INVALID_USAGE');
    last.usage = {input_tokens:usage.input_tokens,output_tokens:usage.output_tokens};
    last.estimateUsd = (usage.input_tokens*GUARD_RATES.inputPerMillionUsd+usage.output_tokens*GUARD_RATES.outputPerMillionUsd)/1_000_000;
    if (this.snapshot().admissionEstimateUsd >= COMPACT_LIMITS.studyUsd) throw new Error('STUDY_SPEND_THRESHOLD');
  }
  snapshot() {return {policy:'reported-usage-stop',thresholdUsd:COMPACT_LIMITS.studyUsd,
    estimateUsd:this.calls.reduce((s,c)=>s+(c.estimateUsd??0),0),
    admissionEstimateUsd:this.calls.reduce((s,c)=>s+(c.estimateUsd??c.reservationUsd),0),
    unknownUsageRequests:this.calls.filter(c=>c.usage===null).length, calls:this.calls,
    rates:GUARD_RATES, invoice:false, overshootPossible:true};}
}
export function compactFetch(base: typeof fetch): typeof fetch {
  let count=0;
  return async (input,init) => {
    if (++count>COMPACT_LIMITS.requests) throw new Error('HTTP_REQUEST_CAP');
    if (typeof init?.body!=='string' || Buffer.byteLength(init.body)>COMPACT_LIMITS.bodyBytes)
      throw new Error('REQUEST_BODY_CAP');
    const response=await base(input,init);
    const reader=response.body?.getReader(); if(!reader) return response;
    const chunks: Uint8Array[]=[]; let bytes=0;
    try {
      while(true) {
        const next=await reader.read(); if(next.done) break;
        bytes+=next.value.byteLength;
        if(bytes>COMPACT_LIMITS.bodyBytes) {await reader.cancel();throw new Error('RESPONSE_BODY_CAP');}
        chunks.push(next.value);
      }
    } finally {reader.releaseLock();}
    return new Response(Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
