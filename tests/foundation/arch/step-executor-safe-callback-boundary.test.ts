/**
 * Phase 1812 Step B (SE-D5): safeCallback 二级 reporter 边界专测。
 *
 * 锁定零递归 callback failure boundary：首错保留（audit + reporter 入参）、
 * 二级 reporter throw 不逃逸、不覆盖首错、不阻断 audit 留证；reporter 失败
 * 自身走 console 边界并携带 label / 首错 / reporter error 三份证据
 * （Step B §7：必须断言三者均可观察，而非仅「不抛」）。
 */
import { describe, expect, it, vi } from 'vitest';
import { safeCallback } from '../../../src/core/step-executor/utils.js';
import { STEP_EXECUTOR_AUDIT_EVENTS } from '../../../src/core/step-executor/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeAudit() {
  const entries: Array<unknown[]> = [];
  const audit = {
    write: (...cols: unknown[]) => { entries.push(cols); },
  } as unknown as AuditLog;
  return { audit, entries };
}

describe('phase 1812: safeCallback 二级 reporter 零递归边界（SE-D5）', () => {
  it('callback 正常：无 reporter、无 audit、无 console', () => {
    const { audit, entries } = makeAudit();
    const reporter = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    safeCallback('ok', () => {}, { onSafeCallbackError: reporter }, audit);

    expect(reporter).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('首错：reporter 收到 (label, 原始 error)，audit 留证首错', () => {
    const { audit, entries } = makeAudit();
    const first = new Error('first boom');
    const reporter = vi.fn();

    safeCallback('onToolResult', () => { throw first; }, { onSafeCallbackError: reporter }, audit);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith('onToolResult', first);
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe(STEP_EXECUTOR_AUDIT_EVENTS.STEP_EXECUTOR_CALLBACK_FAILED);
    expect(entries[0].some(c => String(c).includes('label=onToolResult'))).toBe(true);
    expect(entries[0].some(c => String(c).includes('first boom'))).toBe(true);
  });

  it('二级 reporter throw：不逃逸、不覆盖首错，三份证据（label/首错/reporter error）进 console 边界，audit 仍留证首错', () => {
    const { audit, entries } = makeAudit();
    const first = new Error('first boom');
    const reportErr = new Error('reporter boom');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      safeCallback('onToolCall', () => { throw first; }, {
        onSafeCallbackError: () => { throw reportErr; },
      }, audit),
    ).not.toThrow();

    // console 边界：label + 首错 + 二级 error 均可观察（零递归出口）
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0][0]);
    expect(line).toContain('CALLBACK-REPORT-FAILED');
    expect(line).toContain('label=onToolCall');
    expect(line).toContain('first boom');
    expect(line).toContain('reporter boom');

    // 首错 audit 不被二级失败阻断/覆盖
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe(STEP_EXECUTOR_AUDIT_EVENTS.STEP_EXECUTOR_CALLBACK_FAILED);
    expect(entries[0].some(c => String(c).includes('first boom'))).toBe(true);
    expect(entries[0].some(c => String(c).includes('reporter boom'))).toBe(false);
    errSpy.mockRestore();
  });

  it('无 reporter 时首错仅 audit 留证（回归）', () => {
    const { audit, entries } = makeAudit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      safeCallback('onBeforeLLMCall', () => { throw new Error('boom'); }, undefined, audit),
    ).not.toThrow();

    expect(entries).toHaveLength(1);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
