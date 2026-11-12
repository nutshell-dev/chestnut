/**
 * Phase 1935 Step B — ProcessExec 成功结果独立 stdout 通道
 *
 * 命题：成功 ExecResult 必有纯 stdout；combined output 与 stderr 观察语义不变；
 * stdout 绝不从 output 删减推导（两通道可含相同文字）。
 * 真实子进程（process.execPath）+ 同步写输出，不用 sleep 构造顺序，
 * 不强断言跨管道全局因果顺序（仅断言 output 同时含两通道内容）。
 */

import { describe, it, expect } from 'vitest';
import { exec, execWithHandle, ProcessExecError } from '../../../src/foundation/process-exec/index.js';

const CWD = process.cwd();

/** node -e 脚本：同步写 stdout/stderr 后自然退出（写完成由进程退出担保，无 sleep）。 */
function nodeScript(body: string): string[] {
  return ['-e', body];
}

describe('exec success result stdout channel (phase 1935 Step B)', () => {
  it('成功结果 stdout 只含 stdout 通道；stderr 诊断不混入', async () => {
    const r = await exec(process.execPath, nodeScript(
      'process.stdout.write("protocol-data\\n"); process.stderr.write("diagnostic-only\\n");',
    ), { cwd: CWD });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('protocol-data\n');
    expect(r.stderr).toBe('diagnostic-only\n');
    // combined output 混合观察语义不变：两通道内容都在
    expect(r.output).toContain('protocol-data');
    expect(r.output).toContain('diagnostic-only');
  });

  it('stdout 为空而 stderr 非空：stdout 为真空串，不从 output 推导', async () => {
    const r = await exec(process.execPath, nodeScript(
      'process.stderr.write("warning-only\\n");',
    ), { cwd: CWD });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('warning-only\n');
    expect(r.output).toContain('warning-only');
  });

  it('stderr 为空：stdout 正常、stderr 字段保持 undefined（既有语义）', async () => {
    const r = await exec(process.execPath, nodeScript(
      'process.stdout.write("only-stdout\\n");',
    ), { cwd: CWD });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('only-stdout\n');
    expect(r.stderr).toBeUndefined();
  });

  it('两通道同文：stdout 完整保留，不做字符串删减', async () => {
    const r = await exec(process.execPath, nodeScript(
      'process.stdout.write("same-text\\n"); process.stderr.write("same-text\\n");',
    ), { cwd: CWD });

    expect(r.stdout).toBe('same-text\n');
    expect(r.stderr).toBe('same-text\n');
  });

  it('stdout 含前后空白、换行与 NUL：原样保留、不 trim', async () => {
    const r = await exec(process.execPath, nodeScript(
      'process.stdout.write("  leading\\n\\ntrailing  \\n"); process.stdout.write("nul\\x00inside");',
    ), { cwd: CWD });

    expect(r.stdout).toBe('  leading\n\ntrailing  \nnul\x00inside');
  });

  it('execWithHandle.promise 遵循同一协议', async () => {
    const handle = execWithHandle(process.execPath, nodeScript(
      'process.stdout.write("handle-stdout\\n"); process.stderr.write("handle-stderr\\n");',
    ), { cwd: CWD });

    const r = await handle.promise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('handle-stdout\n');
    expect(r.stderr).toBe('handle-stderr\n');
  });

  it('自然 exit 非零仍抛 ProcessExecError，保留 output/stderr（错误协议不变）', async () => {
    const err = await exec(process.execPath, nodeScript(
      'process.stdout.write("out-before-fail\\n"); process.stderr.write("err-detail\\n"); process.exit(7);',
    ), { cwd: CWD }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ProcessExecError);
    const pe = err as ProcessExecError;
    expect(pe.exitCode).toBe(7);
    expect(pe.output).toContain('out-before-fail');
    expect(pe.output).toContain('err-detail');
    expect(pe.stderr).toBe('err-detail\n');
  });

  it('spawn 失败仍抛 ProcessExecError（无 exitCode），不伪造 stdout', async () => {
    const err = await exec('definitely-not-a-real-command-1935', [], { cwd: CWD }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ProcessExecError);
    const pe = err as ProcessExecError;
    expect(pe.exitCode).toBeNull();
    expect(Object.hasOwn(pe, 'stdout')).toBe(false);
  });
});

describe('exec maxBuffer chunk boundaries (phase 2128 Step B)', () => {
  async function expectExecError(body: string, maxBuffer: number): Promise<ProcessExecError> {
    const err = await exec(process.execPath, nodeScript(body), { cwd: CWD, maxBuffer }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProcessExecError);
    return err as ProcessExecError;
  }

  it('单个 chunk 超过上限时立即终止并保留截断前缀', async () => {
    const maxBuffer = 64;
    const err = await expectExecError(
      `process.stdout.write('x'.repeat(${maxBuffer + 1}));`,
      maxBuffer,
    );

    expect(err.maxBufferExceeded).toBe(true);
    expect(err.output).toBe('x'.repeat(maxBuffer));
    expect(err.termination?.trigger).toBe('max_buffer');
  });

  it('单个 chunk 恰好等于上限时成功，不误触发终止', async () => {
    const maxBuffer = 64;
    const result = await exec(process.execPath, nodeScript(
      `process.stdout.write('x'.repeat(${maxBuffer}));`,
    ), { cwd: CWD, maxBuffer });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('x'.repeat(maxBuffer));
  });

  it('stdout 与 stderr 累计超过上限时触发 max_buffer', async () => {
    const maxBuffer = 32;
    const err = await expectExecError(
      "process.stdout.write('o'.repeat(24)); process.stderr.write('e'.repeat(24));",
      maxBuffer,
    );

    expect(err.maxBufferExceeded).toBe(true);
    expect(Buffer.byteLength(err.output, 'utf8')).toBe(maxBuffer);
    expect(err.output).toMatch(/^[oe]+$/);
    expect(err.termination?.trigger).toBe('max_buffer');
  });
});
