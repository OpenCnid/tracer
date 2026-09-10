import { LIMITS } from './protocol.js';

export class HardCapUnavailable extends Error {
  readonly code = 'HARD_SPEND_BOUND_UNAVAILABLE';
  constructor() {
    super('Paid inference refused: openai 7.15.0 has no reviewed customer-configurable session budget. Best-effort usage, cancellation and delayed project limits cannot prove the USD 5 study ceiling.');
  }
}

export function authorizePaidInference(): never {
  // This is deliberate, not a TODO masked as a functioning budget governor.
  // A future public bound requires a new reviewed protocol and implementation.
  throw new HardCapUnavailable();
}

export class AdmissionCounter {
  private count = 0;
  private bytes = 0;
  admit(output: string) {
    const size = Buffer.byteLength(output);
    if (this.count + 1 > LIMITS.toolExecutions) throw new Error('TOOL_EXECUTION_CAP');
    if (this.bytes + size > LIMITS.toolOutputBytes) throw new Error('TOOL_OUTPUT_BYTE_CAP');
    this.count++; this.bytes += size;
  }
}

export function boundedFetch(base: typeof fetch): typeof fetch {
  let count = 0;
  return async (input, init) => {
    // Four calls reserved for cancellation and final state retrieval after cap.
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const cancel = method === 'POST' && /\/events$/.test(url.pathname) &&
      typeof init?.body === 'string' && init.body === '{"events":[{"type":"agent.session.input.cancel"}]}';
    const cleanup = cancel || (method === 'GET' && /\/agents\/sessions\/[^/]+$/.test(url.pathname));
    const cap = cleanup ? LIMITS.httpRequests : LIMITS.httpRequests - 4;
    if (count >= cap) throw new Error('HTTP_REQUEST_CAP');
    count++;
    return base(input, init);
  };
}
