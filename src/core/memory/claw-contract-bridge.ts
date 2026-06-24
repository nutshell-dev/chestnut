import type { ContractId } from '../contract/types.js';
import type { NotifyClawFn } from '../contract/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ProgressData } from '../contract/index.js';
import { createContractSystem } from '../contract/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import type { ContractSystem } from '../contract/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';

export interface ClawContractBridgeDeps {
  fsFactory: (baseDir: string) => FileSystem;
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  /** phase 104: pre-bound notifyClaw - caller (装配期) bind */
  notifyClaw: NotifyClawFn;
  llm: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs: number;
}

export interface ClawContractBridge {
  getContractProgress(clawId: string, contractId: ContractId): Promise<ProgressData | null>;
  dispose(): Promise<void>;
}

export function createClawContractBridge(deps: ClawContractBridgeDeps): ClawContractBridge {
  const cache = new Map<string, ContractSystem>();

  return {
    async getContractProgress(clawId: string, contractId: ContractId) {
      let cs = cache.get(clawId);
      if (!cs) {
        const location = deps.clawTopology.resolve(makeClawId(clawId));
        if (location.kind !== 'local') return null;
        const cDir = location.clawDir;
        const cFs = deps.fsFactory(cDir);
        const cAudit = createSystemAudit(cFs, cDir);
        cs = createContractSystem({
          clawDir: cDir,
          clawId: makeClawId(clawId),
          fs: cFs,
          audit: cAudit,
          llm: deps.llm,
          toolRegistry: deps.toolRegistry,
          toolTimeoutMs: deps.toolTimeoutMs,
          fsFactory: deps.fsFactory,
          notifyClaw: deps.notifyClaw,
        });
        cache.set(clawId, cs);
      }
      return cs.getProgress(contractId);
    },

    async dispose() {
      // phase 517 B8: allSettled 兜底、单个 ContractSystem.close 失败不阻其他
      // 模式与 manager.ts:1060 一致（_activeContractControllers termination）
      await Promise.allSettled(
        Array.from(cache.values()).map(cs => cs.close()),
      );
      cache.clear();
    },
  };
}
