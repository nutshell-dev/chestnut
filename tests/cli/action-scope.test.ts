/**
 * phase 1874 Step I (cli-audit-lifecycle-fragmented): CLI action resource scope。
 *
 * 矩阵：
 * ① auditFor 同 dir 复用（createDirContext 只建一次）+ 成功路径 disposeAll 覆盖
 * ② disposeAll 幂等 / 反序 / 失败留证（stderr）不阻断其余 dispose
 * ③ register 幂等边界（dispose 后注册 → 立即释放 + 留证）
 * ④ 无 scope 时 actionAuditFor 回落裸创建（非 wrapper 直调路径语义不变）
 * ⑤ wrapper（cliAction）成功路径统一 dispose；action 结束 scope 清除
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createDirContextMock } = vi.hoisted(() => ({ createDirContextMock: vi.fn() }));

vi.mock('../../src/foundation/audit/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/foundation/audit/index.js')>()),
  createDirContext: createDirContextMock,
}));

import {
  createCliActionScope,
  actionAuditFor,
  registerActionResource,
  setCurrentActionScope,
} from '../../src/cli/action-scope.js';
import { cliAction } from '../../src/cli/supervision-policy.js';

function makeFakeAudit() {
  return {
    write: vi.fn(),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
    dispose: vi.fn(),
  };
}

describe('phase 1874 Step I: action resource scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentActionScope(null);
  });

  afterEach(() => {
    setCurrentActionScope(null);
  });

  it('① auditFor 同 dir 复用 + disposeAll 成功释放', async () => {
    const fake = makeFakeAudit();
    createDirContextMock.mockReturnValue({ audit: fake, fs: {} });
    const scope = createCliActionScope({ fsFactory: () => ({} as any) });

    const a1 = scope.auditFor('/claw/x');
    const a2 = scope.auditFor('/claw/x');
    expect(a1).toBe(a2);
    expect(createDirContextMock).toHaveBeenCalledTimes(1);
    expect(fake.dispose).not.toHaveBeenCalled();

    await scope.disposeAll('completed');
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('② disposeAll 幂等 / 反序 / 失败留证不阻断', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => true);
    const scope = createCliActionScope({ fsFactory: () => ({} as any) });
    const order: string[] = [];
    scope.register('first', () => { order.push('first'); });
    scope.register('second', () => { order.push('second'); });
    scope.register('boom', () => { throw new Error('dispose boom'); });
    scope.register('last', () => { order.push('last'); });

    await scope.disposeAll('completed');
    // 反序：last → boom(throw) → second → first；boom 失败不阻断其余
    expect(order).toEqual(['last', 'second', 'first']);
    const stderr = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stderr).toContain('dispose failed');
    expect(stderr).toContain('boom');
    expect(stderr).toContain('reason=completed');

    // 幂等：二次 disposeAll 不重复执行
    await scope.disposeAll('completed');
    expect(order).toEqual(['last', 'second', 'first']);
    stderrSpy.mockRestore();
  });

  it('③ dispose 后 register → 立即释放 + 留证', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => true);
    const scope = createCliActionScope({ fsFactory: () => ({} as any) });
    await scope.disposeAll('completed');

    const late = vi.fn();
    scope.register('late-resource', late);

    expect(late).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
  });

  it('④ 无 scope → actionAuditFor 回落裸创建', () => {
    const fake = makeFakeAudit();
    createDirContextMock.mockReturnValue({ audit: fake, fs: {} });

    const a = actionAuditFor('/claw/y', { fsFactory: () => ({} as any) });
    expect(a).toBe(fake);
    expect(createDirContextMock).toHaveBeenCalledTimes(1);
    // 无 scope 时 register 返回 false（caller 自负责）
    expect(registerActionResource('r', () => {})).toBe(false);
  });

  it('⑤ cliAction 成功路径统一 dispose + scope 清除', async () => {
    const fake = makeFakeAudit();
    createDirContextMock.mockReturnValue({ audit: fake, fs: {} });
    const fsFactory = () => ({} as any);

    const wrapped = cliAction('disabled', async () => {
      actionAuditFor('/claw/z', { fsFactory });
      expect(registerActionResource('extra', () => {})).toBe(true);
    }, { fsFactory });

    await wrapped();

    expect(fake.dispose).toHaveBeenCalledTimes(1);
    // action 结束：scope 已清除 → 回落裸创建
    createDirContextMock.mockClear();
    actionAuditFor('/claw/other', { fsFactory });
    expect(createDirContextMock).toHaveBeenCalledTimes(1);
  });
});
