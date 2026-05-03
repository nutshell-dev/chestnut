import { vi } from 'vitest';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { ContractManager } from '../../src/core/contract/manager.js';
import type { OutboxWriter } from '../../src/foundation/messaging/index.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { TaskSystem, type TaskSystemOptions } from '../../src/core/task/system.js';

export function makeTaskSystemDeps(
  llm?: LLMOrchestrator,
): Pick<TaskSystemOptions, 'llm' | 'contractManager' | 'outboxWriter'> {
  return {
    llm: llm ?? ({} as unknown as LLMOrchestrator),
    contractManager: {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      setOnNotify: vi.fn(),
    } as unknown as ContractManager,
    outboxWriter: {
      write: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboxWriter,
  };
}

export function createTestTaskSystem(
  clawDir: string,
  fs: FileSystem,
  auditWriter: AuditWriter,
  llm?: LLMOrchestrator,
  overrides?: Partial<Omit<TaskSystemOptions, 'llm' | 'contractManager' | 'outboxWriter'>>,
): TaskSystem {
  const deps = makeTaskSystemDeps(llm);
  return new TaskSystem(clawDir, fs, {
    auditWriter,
    ...deps,
    ...overrides,
  });
}
