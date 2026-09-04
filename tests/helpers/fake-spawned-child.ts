/**
 * phase 1763: spawnDetached 的最小 ChildProcess test double。
 *
 * spawnDetached 的提交点由 child 'spawn' 事件定义（Phase 1762 冻结设计），
 * 故 double 必须：1) 支持 once/on/off 事件注册；2) 在创建后经 microtask
 * 自动交付 'spawn' 事件（模拟真实异步提交点）。需要手动控制事件时
 * （如注入 pre-commit 'error'），直接用 node EventEmitter 自建。
 */
import { vi } from 'vitest';

export interface FakeSpawnedChild {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

export function makeFakeSpawnedChild(pid: number, autoCommit = true): FakeSpawnedChild {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const proc: FakeSpawnedChild = {
    pid,
    unref: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return proc;
    }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const wrapper = (...args: unknown[]) => {
        listeners.get(event)?.delete(wrapper);
        cb(...args);
      };
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(wrapper);
      return proc;
    }),
    off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb);
      return proc;
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(...args);
    },
  };
  if (autoCommit) {
    // 模拟真实提交点：'spawn' 异步交付
    queueMicrotask(() => proc.emit('spawn'));
  }
  return proc;
}
