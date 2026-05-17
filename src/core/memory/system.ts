import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { AsyncTaskSystem } from '../async-task-system/system.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import { runDeepDream } from './deep-dream.js';
import { runRandomDream } from './random-dream.js';

export interface MemorySystemOptions {
  clawforumDir: string;
  motionDir: string;
  fs: FileSystem;
  motionFs: FileSystem;               // baseDir = motionDir / NEW
  audit: AuditLog;
  taskSystem: AsyncTaskSystem;
  llmService: LLMOrchestrator;        // ← 注入 LLM（修 N1）
  llmConfig: LLMOrchestratorConfig;   // deep-dream 内部仍需 config（state file 路径等）
  maxCompressionTokens?: number;
  /** 临时构建 per-claw FileSystem 的 factory（assembly 注入 / 业务 0 触 L1 impl）*/
  clawFsFactory: (clawDir: string) => FileSystem;
}

export class MemorySystem {
  constructor(private readonly opts: MemorySystemOptions) {}

  async runDeepDream(maxCompressionTokens?: number, opts?: { signal?: AbortSignal }): Promise<void> {
    return runDeepDream({
      clawforumDir: this.opts.clawforumDir,
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
      clawforumDir: this.opts.clawforumDir,
      motionDir: this.opts.motionDir,
      taskSystem: this.opts.taskSystem,
      fs: this.opts.fs,
      motionFs: this.opts.motionFs,
      audit: this.opts.audit,
      signal: opts?.signal,
    });
  }
}

export function createMemorySystem(opts: MemorySystemOptions): MemorySystem {
  return new MemorySystem(opts);
}
