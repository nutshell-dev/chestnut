import { EventEmitter } from 'events';
import { vi } from 'vitest';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import { TEST_LLM_TIMEOUT_MS } from './test-timeouts.js';

/**
 * Test helper: create a typed mock AuditLog with a vitest spy write method.
 * Use when you only need to assert write calls (no event recording).
 */
export function makeMockAudit(): AuditLog {
  return {
    __brand: 'AuditLog',
    write: vi.fn<(type: string, ...cols: (string | number)[]) => void>(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  } as unknown as AuditLog;
}

/**
 * Test helper: create a mock AuditLog sink that records all written events.
 * Includes an EventEmitter so tests can subscribe to events instead of polling.
 */
export function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const emitter = new EventEmitter();
  const audit: AuditLog = {
    __brand: 'AuditLog',
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
      emitter.emit('write', type, ...cols);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events, emitter };
}

/**
 * Wait for a specific audit event to be emitted.
 * Fast-paths if the event is already in the recorded events array.
 */
export async function waitForAuditEvent(
  emitter: EventEmitter,
  events: Array<[string, ...(string | number)[]]>,
  eventType: string,
  timeoutMs = TEST_LLM_TIMEOUT_MS,
): Promise<void> {
  if (events.some(e => e[0] === eventType)) return;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('write', handler);
      reject(new Error(`timeout waiting for audit event ${eventType}`));
    }, timeoutMs);
    const handler = (type: string) => {
      if (type === eventType) {
        clearTimeout(timer);
        emitter.off('write', handler);
        resolve();
      }
    };
    emitter.on('write', handler);
  });
}

/**
 * Wait for the *next* occurrence of an audit event (does not fast-path past events).
 * Use for sequential / loop scenarios where the same event fires multiple times.
 * phase 372: 立此 helper 替 contract_manager fire-and-forget 测 polling waitFor.
 */
export async function waitForNextAuditEvent(
  emitter: EventEmitter,
  eventType: string,
  timeoutMs = TEST_LLM_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('write', handler);
      reject(new Error(`timeout waiting for next audit event ${eventType}`));
    }, timeoutMs);
    const handler = (type: string) => {
      if (type === eventType) {
        clearTimeout(timer);
        emitter.off('write', handler);
        resolve();
      }
    };
    emitter.on('write', handler);
  });
}

/**
 * Wait for the Nth occurrence of an audit event (counts from subscribe time, does not fast-path past events).
 * Use for "wait until N concurrent verifiers register" / parallel pattern.
 * phase 376: 立此 helper 替 contract verifier vi.waitFor count polling.
 */
export async function waitForNthAuditEvent(
  emitter: EventEmitter,
  eventType: string,
  n: number,
  timeoutMs = TEST_LLM_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const timer = setTimeout(() => {
      emitter.off('write', handler);
      reject(new Error(`timeout waiting for ${n}th audit event ${eventType} (got ${count})`));
    }, timeoutMs);
    const handler = (type: string) => {
      if (type === eventType) {
        count++;
        if (count >= n) {
          clearTimeout(timer);
          emitter.off('write', handler);
          resolve();
        }
      }
    };
    emitter.on('write', handler);
  });
}
