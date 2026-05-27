/**
 * @module L4.ContractSystem.Verification.Mutex
 * Per-(contractId, subtaskId) mutex preventing concurrent sync + async verification paths.
 * Phase 1371 sub-3: completeSubtaskSync vs runVerificationPipeline race guard.
 */

const activePipelines = new Set<string>();

function key(contractId: string, subtaskId: string): string {
  return `${contractId}::${subtaskId}`;
}

export function acquireVerificationMutex(contractId: string, subtaskId: string): boolean {
  const k = key(contractId, subtaskId);
  if (activePipelines.has(k)) return false;
  activePipelines.add(k);
  return true;
}

export function releaseVerificationMutex(contractId: string, subtaskId: string): void {
  activePipelines.delete(key(contractId, subtaskId));
}
