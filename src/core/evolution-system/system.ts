// src/core/evolution-system/system.ts
import type { Audit } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { TaskSystem } from '../task/index.js';
import type { ContractManager } from '../contract/manager.js';
import type { SkillRegistry } from '../skill/index.js';
import type { RetroScheduler } from './retro-scheduler.js';
import { createDefaultRetroScheduler } from './retro-scheduler.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';

export interface EvolutionSystemDeps {
  fs: FileSystem;
  audit: Audit;
  taskSystem: TaskSystem;
  contractManager: ContractManager;
  skillRegistry?: SkillRegistry;   // for SkillSystem.reload coordination
  retroScheduler?: RetroScheduler;  // optional override / default = createDefaultRetroScheduler
}

export interface RetroResult {
  status: 'finished' | 'skipped_duplicate' | 'subagent_timeout' | 'no_skill_output' | 'reload_failed' | 'error';
  detail?: string;
}

export class EvolutionError extends Error {
  readonly code: 'reload_failed' | 'unknown';
  constructor(code: 'reload_failed' | 'unknown', message?: string) {
    super(message);
    this.code = code;
    this.name = 'EvolutionError';
  }
}

export class EvolutionSystem {
  private readonly retroScheduler: RetroScheduler;

  constructor(private readonly deps: EvolutionSystemDeps) {
    this.retroScheduler = deps.retroScheduler ?? createDefaultRetroScheduler();
  }

  async start(): Promise<void> {
    // Subscribe to contract_completed event (Assembly wires this up via callback)
    // Step B 填具体逻辑
  }

  async stop(): Promise<void> {
    // Cleanup hooks
  }

  /** Step B 填：handleReviewRequest 6 步业务物理迁过来 */
  async runRetroForContract(contractId: string, ctx: any): Promise<RetroResult> {
    throw new Error('NOT_IMPLEMENTED — Step B fills');
  }
}
