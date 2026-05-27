/**
 * @module L4.ContractSystem.Verification.Mutex
 * Per-contractId mutex preventing concurrent sync + async verification paths.
 * Phase 1371 sub-3: completeSubtaskSync vs runVerificationPipeline race guard.
 */

const activePipelines = new Set<string>();

export function acquireVerificationMutex(contractId: string): boolean {
  if (activePipelines.has(contractId)) return false;
  activePipelines.add(contractId);
  return true;
}

export function releaseVerificationMutex(contractId: string): void {
  activePipelines.delete(contractId);
}
