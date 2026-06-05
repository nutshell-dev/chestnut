import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import type { LLMOrchestrator, LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { ProgressData } from '../contract/index.js';
import { runDeepDream } from './deep-dream.js';
import { runRandomDream } from './random-dream.js';
import type { ContractId } from '../contract/types.js';
import type { ClawId, ChestnutRoot, ClawDir } from '../../foundation/identity/index.js';



export interface MemorySystemOptions {
  chestnutRoot: ChestnutRoot;
  motionDir: ClawDir;
  fs: FileSystem;
  motionFs: FileSystem;               // baseDir = motionDir / NEW
  audit: AuditLog;
  taskSystem: AsyncTaskSystem;
  llmService: LLMOrchestrator;        // ← 注入 LLM（修 N1）
  llmConfig: LLMOrchestratorConfig;   // deep-dream 内部仍需 config（state file 路径等）
  maxCompressionTokens?: number;
  /** 临时构建 per-claw FileSystem 的 factory（assembly 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: ClawDir) => FileSystem;
  /** M#3：random-dream 读取 contract progress 走 ContractSystem API */
  getContractProgress?: (clawId: ClawId, contractId: ContractId) => Promise<ProgressData>;
}

export class MemorySystem {
  constructor(private readonly opts: MemorySystemOptions) {}

  async runDeepDream(maxCompressionTokens?: number, opts?: { signal?: AbortSignal }): Promise<void> {
    return runDeepDream({
      chestnutRoot: this.opts.chestnutRoot,
      motionDir: this.opts.motionDir,
      motionFs: this.opts.motionFs,
      llmConfig: this.opts.llmConfig,
      llmService: this.opts.llmService,   // 传入注入的 LLM
      maxCompressionTokens: maxCompressionTokens ?? this.opts.maxCompressionTokens,
      fs: this.opts.fs,
      audit: this.opts.audit,
      clawFsFactory: this.opts.clawFsFactory,
      signal: opts?.signal,
    });
  }

  async runRandomDream(opts?: { signal?: AbortSignal }): Promise<void> {
    return runRandomDream({
      chestnutRoot: this.opts.chestnutRoot,
      motionDir: this.opts.motionDir,
      taskSystem: this.opts.taskSystem,
      fs: this.opts.fs,
      motionFs: this.opts.motionFs,
      audit: this.opts.audit,
      signal: opts?.signal,
      getContractProgress: this.opts.getContractProgress,
    });
  }
}

export function createMemorySystem(opts: MemorySystemOptions): MemorySystem {
  return new MemorySystem(opts);
}
