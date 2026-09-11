export interface StateObservation {
  pressure: boolean;
  retrievalCorrect: boolean;
  stateIntact: boolean;
  boundaryVerified: boolean;
  locatorFailure: boolean;
}

export function decideState(rows: StateObservation[]) {
  const control = rows.find(r => !r.pressure);
  const pressure = rows.filter(r => r.pressure);
  if (!control?.retrievalCorrect || !control.stateIntact)
    return {outcome: 'inconclusive', reason: 'SHORT_CONTROL_NOT_ESTABLISHED'};
  if (pressure.some(r => r.boundaryVerified && r.stateIntact && r.locatorFailure))
    return {outcome: 'refuted-for-tested-workflow', reason: 'VERIFIED_POST_COMPACTION_LOCATOR_FAILURE'};
  if (pressure.length === 2 && pressure.every(r => r.boundaryVerified && r.stateIntact && r.retrievalCorrect))
    return {outcome: 'supported-at-tested-boundaries', reason: 'TWO_VERIFIED_COMPACTION_CONTINUATIONS'};
  return {outcome: 'inconclusive', reason: 'COMPACTION_BOUNDARY_OR_RETRIEVAL_UNESTABLISHED'};
}
