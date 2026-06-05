import * as path from 'path';
import type { ContractId } from '../contract/types.js';
import type { ClawId, ChestnutRoot } from '../../foundation/paths.js';
import { makeClawDir } from '../../foundation/paths.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ProgressData } from '../contract/index.js';
import { createContractSystem } from '../contract/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import type { ContractSystem } from '../contract/index.js';

export interface ClawContractBridgeDeps {
  fsFactory: (baseDir: string) => FileSystem;
  chestnutRoot: ChestnutRoot;
  llm: LLMOrchestrator;
  toolRegistry: ToolRegistry;
  toolTimeoutMs: number;
}

export interface ClawContractBridge {
  getContractProgress(clawId: ClawId, contractId: ContractId): Promise<ProgressData>;
  dispose(): Promise<void>;
}

export function createClawContractBridge(deps: ClawContractBridgeDeps): ClawContractBridge {
  const cache = new Map<string, ContractSystem>();

  return {
    async getContractProgress(clawId: ClawId, contractId: ContractId) {
      let cs = cache.get(clawId);
      if (!cs) {
        const cDir = makeClawDir(path.join(deps.chestnutRoot, CLAWS_DIR, clawId));
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
