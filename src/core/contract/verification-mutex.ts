/**
 * @module L4.ContractSystem.Verification.Mutex
 * Per-(contractId, subtaskId) mutex preventing concurrent sync + async verification paths.
 *
 * History:
 * - phase 1371 sub-3: 首立 module-level singleton (completeSubtaskSync vs runVerificationPipeline race guard)
 * - phase 1465: 模块级 singleton → ContractSystem instance state
 *   (M#3 资源唯一归属 + Tier 1 `feedback_flaky_test_zero_tolerance` 真治)
 *
 * 改前 module-level `const activePipelines = new Set<string>()` 跨 vitest worker pool
 * leak entry / 测试需 `_resetVerificationMutexForTest` global hook 防 leak / 测试 file
 * 间依赖 worker 顺序的隐式假设。改后每 ContractSystem 实例自管 mutex、per-test
 * 自然 fresh instance 即 fresh mutex、无需 reset hook。
 */

export class VerificationMutex {
  private readonly activePipelines = new Set<string>();

  private key(contractId: string, subtaskId: string): string {
    return `${contractId}::${subtaskId}`;
  }

  acquire(contractId: string, subtaskId: string): boolean {
    const k = this.key(contractId, subtaskId);
    if (this.activePipelines.has(k)) return false;
    this.activePipelines.add(k);
    return true;
  }

  release(contractId: string, subtaskId: string): void {
    this.activePipelines.delete(this.key(contractId, subtaskId));
  }
}
