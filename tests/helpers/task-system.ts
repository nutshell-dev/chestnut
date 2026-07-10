import { vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { ContractSystem } from '../../src/core/contract/manager.js';
import type { OutboxWriter } from '../../src/foundation/messaging/index.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { AsyncTaskSystem, type AsyncTaskSystemOptions } from '../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../src/core/async-task-system/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { Watcher, WatcherFactory, WatchEvent } from '../../src/foundation/file-watcher/index.js';

export function makeTestRegistry(): ToolRegistryImpl {
  return new ToolRegistryImpl();
}

export function makeTaskSystemDeps(
  llm?: LLMOrchestrator,
): Pick<AsyncTaskSystemOptions, 'llm' | 'contractManager' | 'outboxWriter' | 'registry' | 'askMotionToolFactory'> {
  return {
    llm: llm ?? ({} as unknown as LLMOrchestrator),
    contractManager: {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      setOnNotify: vi.fn(),
    } as unknown as ContractSystem,
    outboxWriter: {
      write: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboxWriter,
    registry: makeTestRegistry(),
    askMotionToolFactory: () => ({ name: 'ask_motion', description: '', readonly: false, idempotent: false, schema: { type: 'object' }, execute: vi.fn(async () => ({ ok: true, content: '' })) } as unknown as import('../../src/foundation/tools/index.js').Tool),
  };
}

export function createTestTaskSystem(
  clawDir: string,
  fs: FileSystem,
  auditWriter: AuditWriter,
  llm?: LLMOrchestrator,
  overrides?: Partial<Omit<AsyncTaskSystemOptions, 'llm' | 'contractManager' | 'outboxWriter' | 'registry'>>,
): AsyncTaskSystem {
  const deps = makeTaskSystemDeps(llm);
  return new AsyncTaskSystem(clawDir, fs, {
    auditWriter,
    shortIdIndex: new InMemoryShortIdIndex(),
    ...deps,
    ...overrides,
  });
}

/**
 * phase 86: mock watcher factory that auto-fires 'add' events by intercepting
 * fs.writeAtomic calls. Eliminates chokidar OS-bound timing for fast project tests.
 *
 * Wraps fs.writeAtomic on first watcher creation and restores on last close().
 */
export function createMockWatcherFactory(fs: FileSystem): { factory: WatcherFactory } {
  let originalWriteAtomic: FileSystem['writeAtomic'] | null = null;
  const activeWatchers: Array<{
    watchPath: string;
    callback: (e: WatchEvent) => void;
    active: boolean;
  }> = [];

  const factory: WatcherFactory = (watchPath, callback, _opts) => {
    if (!originalWriteAtomic) {
      originalWriteAtomic = fs.writeAtomic.bind(fs);
      fs.writeAtomic = (async (p: string, content: string) => {
        await originalWriteAtomic!(p, content);
        const resolved = fs.resolve(p);
        for (const w of activeWatchers) {
          if (!w.active) continue;
          if (resolved.startsWith(w.watchPath) && resolved.endsWith('.json')) {
            queueMicrotask(() => w.callback({ type: 'add', path: resolved }));
          }
        }
      }) as FileSystem['writeAtomic'];
    }
    const entry = { watchPath, callback, active: true };
    activeWatchers.push(entry);

    return {
      close: async () => {
        entry.active = false;
        if (activeWatchers.every(w => !w.active) && originalWriteAtomic) {
          fs.writeAtomic = originalWriteAtomic;
          originalWriteAtomic = null;
        }
      },
      isActive: () => entry.active,
      getPath: () => watchPath,
    };
  };

  return { factory };
}

/**
 * Lightweight mock AsyncTaskSystem for unit tests that only need schedule().
 * Writes pending files directly to fs (mirror phase 1332 N2 migration).
 */
export function createMockTaskSystem(fs: FileSystem, auditWriter?: AuditLog): AsyncTaskSystem {
  return {
    schedule: async (_kind: 'subagent', payload: Record<string, unknown>) => {
      const taskId = randomUUID();
      const task = { ...payload, id: taskId, createdAt: new Date().toISOString() };
      await fs.writeAtomic(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`, JSON.stringify(task, null, 2));
      if (auditWriter) {
        auditWriter.write('task_scheduled', `taskId=${taskId}`, `kind=subagent`);
      }
      return taskId;
    },
  } as unknown as AsyncTaskSystem;
}
