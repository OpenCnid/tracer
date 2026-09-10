import type { Arm } from './protocol.js';
import type { Collected } from './collector.js';

// Route facts are reviewer annotations grounded in independently retained traces.
// The collector never creates an 'executed' or 'runtime-rejected' annotation.
export interface RouteReview {
  decision: 'executed' | 'runtime-rejected' | 'unestablished';
  rejectionCategory?: string;
}
export interface TrialEvidence extends Collected {
  block: number; arm: Arm; review: RouteReview;
}

export function decide(rows: TrialEvidence[]) {
  const correct = (r: TrialEvidence | undefined, children: number) => !!r && r.historyComplete &&
    r.terminal === 'agent.session.turn.completed' && r.taskCorrect === true && r.error === null &&
    r.completedChildren === children && r.review.decision === 'executed';
  const outcomes: Array<'supported' | 'rejected' | 'inconclusive'> = [];
  const categories: string[] = [];
  const ids = new Set(rows.map(r => r.sessionId).filter(Boolean));
  if (rows.length !== 9 || ids.size !== 9) return { outcome: 'inconclusive', reason: 'INCOMPLETE_OR_REUSED_SESSIONS' };
  for (const block of [1, 2, 3]) {
    const group = rows.filter(r => r.block === block);
    if (group.length !== 3 || new Set(group.map(r => r.arm)).size !== 3)
      return { outcome: 'inconclusive', reason: 'INVALID_MATRIX' };
    const direct = group.find(r => r.arm === 'direct-native');
    const local = group.find(r => r.arm === 'programmatic-local');
    const native = group.find(r => r.arm === 'programmatic-native')!;
    if (!correct(direct, 2) || !correct(local, 0)) { outcomes.push('inconclusive'); continue; }
    if (correct(native, 2)) outcomes.push('supported');
    else if (native.historyComplete && native.review.decision === 'runtime-rejected' && native.review.rejectionCategory) {
      outcomes.push('rejected'); categories.push(native.review.rejectionCategory);
    } else outcomes.push('inconclusive');
  }
  if (outcomes.every(o => o === 'supported')) return { outcome: 'supported', reason: 'FINITE_NATIVE_SEAM_ESTABLISHED' };
  if (outcomes.includes('supported') && outcomes.includes('rejected'))
    return { outcome: 'inconclusive', reason: 'MIXED_BETA_BEHAVIOR' };
  if (categories.some(c => categories.filter(x => x === c).length >= 2))
    return { outcome: 'refuted', reason: 'REPEATED_RUNTIME_REJECTION_WITH_WORKING_CONTROLS' };
  return { outcome: 'inconclusive', reason: 'INSUFFICIENT_ROUTE_OR_CONTROL_EVIDENCE' };
}
