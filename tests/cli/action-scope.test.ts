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
import { CliError } from '../../src/cli/errors.js';

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

  it('⑥ phase 1874 Step H+J: 错误路径先结算+dispose、再 process.exit（exit code 不变）', async () => {
    const byDir = new Map<string, ReturnType<typeof makeFakeAudit>>();
    createDirContextMock.mockImplementation((_deps: unknown, dir: string) => {
      const a = makeFakeAudit();
      byDir.set(dir, a);
      return { audit: a, fs: {} };
    });
    const fsFactory = () => ({} as any);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => true);

    const order: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => {
      order.push('exit');
      throw new Error('exit called');
    }) as unknown as typeof process.exit));

    const wrapped = cliAction('disabled', async () => {
      const audit = actionAuditFor('/claw/err', { fsFactory });
      audit.dispose.mockImplementation(() => { order.push('dispose:claw'); });
      throw new CliError('boom', 2);
    }, { fsFactory });

    await expect(wrapped()).rejects.toThrow('exit called');
    // 错误边界顺序：dispose 全部先于 exit；exit code 保持 CliError code
    expect(order).toEqual(['dispose:claw', 'exit']);
    expect(exitSpy).toHaveBeenCalledWith(2);
    // 失败结算证据：outcome=error + exit_code=2 + error_class=CliError，且落盘先于 dispose
    const rootAudit = [...byDir.entries()].find(([k]) => k !== '/claw/err')![1];
    const settledRow = rootAudit.write.mock.calls.find((c: unknown[]) => c[0] === 'cli_settled');
    expect(settledRow).toBeDefined();
    expect(settledRow!.some((c: unknown) => String(c) === 'outcome=error')).toBe(true);
    expect(settledRow!.some((c: unknown) => String(c) === 'exit_code=2')).toBe(true);
    expect(settledRow!.some((c: unknown) => String(c) === 'error_class=CliError')).toBe(true);
    expect(rootAudit.dispose).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('⑥b 显式 exit 豁免路径：exit 钩子补结算（一次 invoke 仅一对事件、exit_code 取 process.exitCode）', async () => {
    const byDir = new Map<string, ReturnType<typeof makeFakeAudit>>();
    createDirContextMock.mockImplementation((_deps: unknown, dir: string) => {
      const a = makeFakeAudit();
      byDir.set(dir, a);
      return { audit: a, fs: {} };
    });
    const fsFactory = () => ({} as any);
    const prevExitCode = process.exitCode;

    const wrapped = cliAction('disabled', async () => {
      // 模拟 §7.B 显式 exit 站点：置 exitCode 并触发进程退出事件（真实 process.exit 同义）
      process.exitCode = 3;
      process.emit('exit', 3 as never);
    }, { fsFactory });

    await wrapped();
    process.exitCode = prevExitCode;

    const rootAudit = [...byDir.entries()].find(([k]) => !k.startsWith('/claw'))![1];
    const settledRows = rootAudit.write.mock.calls.filter((c: unknown[]) => c[0] === 'cli_settled');
    expect(settledRows).toHaveLength(1);   // 钩子结算后 finally 不重复
    expect(settledRows[0].some((c: unknown) => String(c) === 'exit_code=3')).toBe(true);
    const invokeRows = rootAudit.write.mock.calls.filter((c: unknown[]) => c[0] === 'cli_invoke');
    expect(invokeRows).toHaveLength(1);
  });

  it('⑤ cliAction 成功路径统一 dispose（含 root 事件 audit）+ 事件对 + scope 清除', async () => {
    const byDir = new Map<string, ReturnType<typeof makeFakeAudit>>();
    createDirContextMock.mockImplementation((_deps: unknown, dir: string) => {
      const a = makeFakeAudit();
      byDir.set(dir, a);
      return { audit: a, fs: {} };
    });
    const fsFactory = () => ({} as any);

    const wrapped = cliAction('disabled', async () => {
      actionAuditFor('/claw/z', { fsFactory });
      expect(registerActionResource('extra', () => {})).toBe(true);
    }, { fsFactory });

    await wrapped();

    // 本 action 创建的全部 audit（root 事件 audit + handler dir audit）均 dispose
    const rootAudit = byDir.get(String(process.cwd()) === '' ? '' : [...byDir.keys()].find(k => k !== '/claw/z')!);
    expect(rootAudit).toBeDefined();
    expect(byDir.get('/claw/z')!.dispose).toHaveBeenCalledTimes(1);
    expect(rootAudit!.dispose).toHaveBeenCalledTimes(1);
    // phase 1874 Step J: invoke/settled 事件对（command/exit_code/duration）
    const rootWrites = rootAudit!.write.mock.calls;
    expect(rootWrites[0][0]).toBe('cli_invoke');
    const settledRow = rootWrites.find((c: unknown[]) => c[0] === 'cli_settled');
    expect(settledRow).toBeDefined();
    expect(settledRow!.some((c: unknown) => String(c).startsWith('outcome=ok'))).toBe(true);
    expect(settledRow!.some((c: unknown) => String(c) === 'exit_code=0')).toBe(true);
    expect(settledRow!.some((c: unknown) => String(c).startsWith('duration_ms='))).toBe(true);
    // action 结束：scope 已清除 → 回落裸创建
    createDirContextMock.mockClear();
    actionAuditFor('/claw/other', { fsFactory });
    expect(createDirContextMock).toHaveBeenCalledTimes(1);
  });
});
