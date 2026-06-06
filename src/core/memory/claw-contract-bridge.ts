import * as path from 'path';
import type { ContractId } from '../contract/types.js';
import type { ChestnutRoot } from '../../assembly/install-paths.js';
import type { ClawId } from '../../foundation/paths.js';
import { makeClawDir } from '../../foundation/paths.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ProgressData } from '../contract/index.js';
import { createContractSystem } from '../contract/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import type { ContractSystem } from '../contract/index.js';

export interface ClawContractBridgeDeps {
  fsFactory: (baseDir: string) => FileSystem;
  /** phase 84: claws dir 用于 cross-claw enum；contract Manager 仍接 ChestnutRoot brand、保过渡 */
  clawsDir: string;
  chestnutRoot: ChestnutRoot;
  llm: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs: number;
}

export interface ClawContractBridge {
  getContractProgress(clawId: ClawId, contractId: ContractId): Promise<ProgressData | null>;
  dispose(): Promise<void>;
}

export function createClawContractBridge(deps: ClawContractBridgeDeps): ClawContractBridge {
  const cache = new Map<string, ContractSystem>();

  return {
    async getContractProgress(clawId: ClawId, contractId: ContractId) {
      let cs = cache.get(clawId);
      if (!cs) {
        const cDir = makeClawDir(path.join(deps.clawsDir, clawId));
        const cFs = deps.fsFactory(cDir);
        const cAudit = createSystemAudit(cFs, cDir);
        cs = createContractSystem({
          clawDir: cDir,
          clawId,
          fs: cFs,
          audit: cAudit,
          llm: deps.llm,
          toolRegistry: deps.toolRegistry,
          toolTimeoutMs: deps.toolTimeoutMs,
          fsFactory: deps.fsFactory,
          chestnutRoot: deps.chestnutRoot,
        });
        cache.set(clawId, cs);
      }
      return cs.getProgress(contractId);
    },

    async dispose() {
      for (const cs of cache.values()) {
        await cs.close();
      }
      cache.clear();
    },
  };
}
