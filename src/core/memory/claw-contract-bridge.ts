import type { ContractId, ContractProgressReader, ProgressData } from '../contract/index.js';
import { makeClawId, type ClawId } from '../../foundation/claw-identity/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';

interface ClawContractBridgeDeps {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  /**
   * Phase 1807 Step B（MEMORY-CONTRACT-BRIDGE-OVERWIDE-ADAPTER）：装配层注入的
   * per-claw reader 工厂。Memory 只缓存窄 capability，不再构造/持有完整
   * ContractSystem——LLM、ToolRegistry、notify 与 audit 构造、close 生命
   * 周期全部归 ContractSystem owner/装配层（工厂内部自由装配，Memory 不可见）。
   */
  createReader: (clawId: ClawId, clawDir: string) => Promise<ContractProgressReader>;
}

interface ClawContractBridge {
  getContractProgress(clawId: string, contractId: ContractId): Promise<ProgressData | null>;
  dispose(): Promise<void>;
}

export function createClawContractBridge(deps: ClawContractBridgeDeps): ClawContractBridge {
  const cache = new Map<string, ContractProgressReader>();

  return {
    async getContractProgress(clawId: string, contractId: ContractId) {
      let reader = cache.get(clawId);
      if (!reader) {
        const location = deps.clawTopology.resolve(makeClawId(clawId));
        if (location.kind !== 'local') return null;
        // 只读 getProgress 用途；reader 由装配层工厂创建并缓存（每 claw 一个）。
        reader = await deps.createReader(makeClawId(clawId), location.clawDir);
        cache.set(clawId, reader);
      }
      return reader.getProgress(contractId);
    },

    async dispose() {
      // phase 1807：reader 生命周期（含底层 ContractSystem.close）归装配层——
      // bridge 只丢弃缓存的 capability 引用，不触碰 close。
      cache.clear();
    },
  };
}
