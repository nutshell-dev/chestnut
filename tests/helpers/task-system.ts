import { vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { ContractSystem } from '../../src/core/contract/manager.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { AsyncTaskSystem, type AsyncTaskSystemOptions } from '../../src/core/async-task-system/system.js';
import { createStandardDeliverySink } from '../../src/core/async-task-system/index.js';
import { createSubagentTaskExecutor } from '../../src/assembly/subagent-task-executor.js';
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
): Pick<AsyncTaskSystemOptions, 'taskExecutor' | 'deliverySink' | 'contractManager' | 'registry'> {
  return {
    // phase 1863 (AT-D5)：最小执行/交付面——测试默认装配（真实 adapter + 标准 sink）
    taskExecutor: createSubagentTaskExecutor({
      llm: llm ?? ({} as unknown as LLMOrchestrator),
      registry: makeTestRegistry(),
    }),
    deliverySink: createStandardDeliverySink(),
    contractManager: {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      setOnNotify: vi.fn(),
    } as unknown as ContractSystem,
    registry: makeTestRegistry(),
  };
}

export function createTestTaskSystem(
  clawDir: string,
  fs: FileSystem,
  auditWriter: AuditWriter,
  llm?: LLMOrchestrator,
  overrides?: Partial<Omit<AsyncTaskSystemOptions, 'llm' | 'contractManager' | 'registry'>>,
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
        // Phase 1869 (Step E 随改): 透传 AtomicWriteResult —— 原先吞掉返回值
        // 违反 FileSystem 契约，破坏消费写入结果的写入方（inbox-writer 耐久性三态消费）。
        const result = await originalWriteAtomic!(p, content);
        const resolved = fs.resolve(p);
        for (const w of activeWatchers) {
          if (!w.active) continue;
          if (resolved.startsWith(w.watchPath) && resolved.endsWith('.json')) {
            queueMicrotask(() => w.callback({ type: 'add', path: resolved }));
          }
        }
        return result;
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
      const task = { ...payload, id: taskId, shortId: taskId.slice(0, 8), createdAt: new Date().toISOString() };
      await fs.writeAtomic(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`, JSON.stringify(task, null, 2));
      if (auditWriter) {
        auditWriter.write('task_scheduled', `taskId=${taskId}`, `kind=subagent`);
      }
      return taskId;
    },
  } as unknown as AsyncTaskSystem;
}
