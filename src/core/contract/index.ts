/**
 * @module L4.ContractSystem
 * Contract module exports
 */

import { ContractSystem } from './manager.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { AuditWriter } from '../../foundation/audit/writer.js';
import type { ContractVerifierScheduler } from './verifier-scheduler.js';


export {
  ContractSystem,
  type ProgressData,
  type AcceptanceResult,
} from './manager.js';

export { doneTool, DONE_TOOL_NAME } from './builtins/done.js';

/**
 * ContractSystem 工厂 —— 严格对齐 ctor 7 参数
 *
 * 输入：clawDir / clawId / fs 必填；llm / verifierScheduler 可选
 * 输出：ContractSystem 实例
 * 边界：可选参数未传时运行期能力降级（见 design/modules/l4_contract_system.md §2.a）
 * 失败：不抛；能力降级延迟到方法调用
 */
export function createContractSystem(
  clawDir: string,
  clawId: string,
  fs: FileSystem,
  audit: AuditWriter,
  llm?: LLMOrchestrator,
  verifierScheduler?: ContractVerifierScheduler,
): ContractSystem {
  return new ContractSystem(clawDir, clawId, fs, audit, llm, verifierScheduler);
}
