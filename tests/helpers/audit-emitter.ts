/**
 * Audit emitter helper — Promise / event 驱动替 setTimeout poll loop.
 *
 * test 内常见 pattern: 等 audit 内某 type 出现 N 次。原实现用 setTimeout(r, 5ms) 紧轮询、
 * 改为 audit.write 时 emit 通知 listener、用 Promise.race + safety timeout 兜底.
 *
 * Per 项目设计原则「事件驱动、避免预灌上下文」.
 */

import type { AuditWriter } from '../../src/foundation/audit/writer.js';

export type AuditRow = [string, ...(string | number)[]];

export interface AuditEmitterHelper {
  /** Wrap real audit writer + emit 通知 listeners */
  audit: AuditWriter;
  /** All emitted events accumulator (in order) */
  events: AuditRow[];
  /** Filter events by type */
  filter(type: string): AuditRow[];
  /** Wait for predicate to be satisfied; reject after timeoutMs */
  waitFor(predicate: (events: readonly AuditRow[]) => boolean, timeoutMs: number): Promise<void>;
  /** Wait for >=count events of given type */
  waitForType(type: string, count: number, timeoutMs: number): Promise<AuditRow[]>;
}

/**
 * Create audit emitter helper wrapping realAudit.
 *
 * write 路径同时累 events + 通知 listeners.
 * waitFor 路径: 检查 predicate；满足→resolve；否则订阅 listener、超时 reject.
 */
export function createAuditEmitterHelper(realAudit: AuditWriter): AuditEmitterHelper {
  const events: AuditRow[] = [];
  const listeners = new Set<() => void>();

  const wrappedAudit: AuditWriter = {
    ...realAudit,
    write(type: string, ...cols: (string | number)[]) {
      events.push([type, ...cols]);
      realAudit.write(type, ...cols);
      // emit: 通知所有 waiting listener 检查 predicate
      for (const listener of listeners) listener();
    },
    preview: (s: string) => realAudit.preview(s),
    message: (s: string) => realAudit.message(s),
    summary: (s: string) => realAudit.summary(s),
  } as AuditWriter;

  const filter = (type: string): AuditRow[] => events.filter(([t]) => t === type);

  const waitFor = (
    predicate: (events: readonly AuditRow[]) => boolean,
    timeoutMs: number,
  ): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (predicate(events)) return resolve();

      let resolved = false;
      const cleanup = (): void => {
        listeners.delete(check);
        clearTimeout(timer);
      };
      const check = (): void => {
        if (resolved) return;
        if (predicate(events)) {
          resolved = true;
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`audit waitFor timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      listeners.add(check);
    });
  };

  const waitForType = (type: string, count: number, timeoutMs: number): Promise<AuditRow[]> => {
    return waitFor((evs) => evs.filter(([t]) => t === type).length >= count, timeoutMs)
      .then(() => filter(type));
  };

  return { audit: wrappedAudit, events, filter, waitFor, waitForType };
}
