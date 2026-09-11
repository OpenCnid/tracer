import { LIMITS } from './protocol.js';
import type { TokenUsage } from 'openai/resources/beta/agents/agents';

export class HardCapUnavailable extends Error {
  readonly code = 'HARD_SPEND_BOUND_UNAVAILABLE';
  constructor() {
    super(`Paid inference refused: openai 7.15.0 has no reviewed customer-configurable session budget. Best-effort usage, cancellation and delayed project limits cannot prove the USD ${LIMITS.studyUsd} study ceiling.`);
  }
}

export function authorizePaidInference(policy: 'strict' | 'reported-usage-stop' = 'strict'): void {
  if (policy !== 'reported-usage-stop') throw new HardCapUnavailable();
  // Explicitly authorized by OpenCnid and frozen in native-seam-v2.
  // This permission does not turn delayed usage/cancellation into a hard cap.
}

export const GUARD_RATES = Object.freeze({ inputPerMillionUsd: 0.5, outputPerMillionUsd: 1.8 });
type Counts = { input_tokens: number; output_tokens: number };
type SessionUsage = { aggregate: Counts | null; turns: Map<string, Counts | null> };

function counts(usage: TokenUsage | null | undefined): Counts | null {
  if (!usage) return null;
  if (![usage.input_tokens, usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0))
    throw new Error('INVALID_USAGE_COUNTS');
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
}
function highWater(old: Counts | null, next: Counts | null): Counts | null {
  if (!next) return old;
  if (!old) return next;
  return { input_tokens: Math.max(old.input_tokens, next.input_tokens), output_tokens: Math.max(old.output_tokens, next.output_tokens) };
}
const price = (value: Counts | null) => value ?
  (value.input_tokens * GUARD_RATES.inputPerMillionUsd + value.output_tokens * GUARD_RATES.outputPerMillionUsd) / 1_000_000 : 0;

export class UsageGuard {
  private readonly sessions = new Map<string, SessionUsage>();
  constructor(readonly model: string, readonly studyUsd: number = LIMITS.studyUsd, readonly trialUsd: number = LIMITS.reservationUsd,
    readonly priorEstimateUsd = 0) {}
  private session(id: string) {
    let value = this.sessions.get(id);
    if (!value) { value = { aggregate: null, turns: new Map() }; this.sessions.set(id, value); }
    return value;
  }
  observeModel(model: string | null | undefined) {
    if (model && model !== this.model) throw new Error('UNEXPECTED_BILLED_MODEL');
  }
  observeSession(id: string, usage: TokenUsage | null | undefined) {
    const value = this.session(id); value.aggregate = highWater(value.aggregate, counts(usage));
  }
  observeTurn(sessionId: string, turn: {id: string; usage?: TokenUsage | null}, fallback?: TokenUsage | null) {
    const value = this.session(sessionId);
    const next = highWater(counts(turn.usage), counts(fallback));
    value.turns.set(turn.id, highWater(value.turns.get(turn.id) ?? null, next));
  }
  snapshot() {
    const sessions = [...this.sessions].map(([id, value]) => {
      const turns = [...value.turns].map(([turnId, usage]) => ({ turnId, usage, estimateUsd: usage ? price(usage) : null }));
      const known = value.aggregate !== null || turns.some(t => t.usage !== null);
      const estimateUsd = known ? Math.max(price(value.aggregate), turns.reduce((sum, t) => sum + (t.estimateUsd ?? 0), 0)) : null;
      const usagePending = !turns.length || turns.some(t => t.usage === null);
      return { id, aggregate: value.aggregate, turns, estimateUsd, usagePending,
        admissionEstimateUsd: Math.max(estimateUsd ?? 0, usagePending ? this.trialUsd : 0) };
    });
    return { policy: 'reported-usage-stop', thresholdUsd: this.studyUsd, trialThresholdUsd: this.trialUsd,
      priorEstimateUsd: this.priorEstimateUsd,
      allObservedTurnsHaveUsage: sessions.length > 0 && sessions.every(s => s.turns.length > 0 && s.turns.every(t => t.usage !== null)),
      unknownTurnCount: sessions.reduce((sum, s) => sum + s.turns.filter(t => t.usage === null).length, 0),
      admissionEstimateUsd: this.priorEstimateUsd + sessions.reduce((sum, s) => sum + s.admissionEstimateUsd, 0),
      estimateUsd: this.priorEstimateUsd > 0 || sessions.some(s => s.estimateUsd !== null) ?
        this.priorEstimateUsd + sessions.reduce((sum, s) => sum + (s.estimateUsd ?? 0), 0) : null,
      sessions, rates: GUARD_RATES, invoice: false, overshootPossible: true };
  }
  check(sessionId: string) {
    const snapshot = this.snapshot();
    if (snapshot.admissionEstimateUsd >= this.studyUsd) throw new Error('STUDY_SPEND_THRESHOLD');
    if ((snapshot.sessions.find(s => s.id === sessionId)?.estimateUsd ?? 0) >= this.trialUsd)
      throw new Error('TRIAL_SPEND_THRESHOLD');
  }
  hasUsage(sessionId: string) {
    return this.snapshot().sessions.find(s => s.id === sessionId)?.estimateUsd != null;
  }
  requireComplete(sessionId: string) {
    const value = this.session(sessionId);
    if (!value.turns.size || [...value.turns.values()].some(v => v === null)) throw new Error('FINAL_USAGE_INCOMPLETE');
    this.check(sessionId);
  }
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
