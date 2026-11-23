/**
 * Program top-level `chestnut --help` claw term cleanup — phase 1488.
 *
 * Coverage:
 * - `chestnut --help` 顶层 Commands 列表 `claw` 行只显 `claw`
 *   （不漏 commander 内部抽象 `[subject]` / `[args...]`）
 * - `claw` 的 description 仍正确
 * - motion 子命令 `step <n>` 的 positional 仍正常显示（防 side-effect 泄露）
 * - help [command] 的 commander 内建仍正常显示
 * - sister sibling cmd（contract / motion / skill）只显 name + description（无 args）
 *
 * 反向：旧 `claw [subject] [args...]` 字面不应出现在顶层
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  runChildProcess,
  type ChildProcessResult,
} from '../utils/child-process.js';

const CLI_WORKSPACE = path.resolve(__dirname, '../..');
const CLI_ENTRY = path.resolve(CLI_WORKSPACE, 'dist/cli.js');
const HELP_CASE_EXECUTION_BUDGET_MS = 12_000; // 15s test budget minus termination and assertion reserve.

function helpEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, CHESTNUT_CALLER_AGENT_ID: undefined };
}

function helpStdout(result: ChildProcessResult): string {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Help CLI exited ${result.status}: ${result.stderr}`, { cause: result.error });
  }
  return result.stdout;
}

async function runHelp(args: string[], signal: AbortSignal): Promise<string> {
  const result = await runChildProcess(process.execPath, [CLI_ENTRY, ...args], {
    cwd: CLI_WORKSPACE,
    env: helpEnvironment(),
    timeoutMs: HELP_CASE_EXECUTION_BUDGET_MS,
    signal,
  });
  return helpStdout(result);
}

describe('chestnut top-level help (phase 1488)', () => {
  it('top-level `claw` row shows only `claw` (no commander internal `[subject]`/`[args...]`)', async context => {
    const out = await runHelp(['--help'], context.signal);
    // 顶层应有 `  claw ` 行（行起头两空格 + claw + 至少一空格 + description）
    expect(out).toMatch(/^\s{2,}claw\s{2,}Manage Claws/m);
    // 反向：旧形态字面不应出现
    expect(out).not.toContain('claw [subject]');
    expect(out).not.toContain('claw [subject] [args...]');
  });

  it('top-level `claw` description preserved', async context => {
    const out = await runHelp(['--help'], context.signal);
    expect(out).toContain('Manage Claws (run `chestnut claw help` for full reference)');
  });

  it('motion subcommand `step <n>` positional preserved (no side-effect leak)', async context => {
    const out = await runHelp(['motion', '--help'], context.signal);
    // 子命令层不被影响、positional `<n>` 仍显
    expect(out).toMatch(/^\s{2,}step <n>\s{2,}/m);
  });

  it('built-in `help [command]` positional preserved at top level', async context => {
    const out = await runHelp(['--help'], context.signal);
    expect(out).toMatch(/^\s{2,}help \[command\]\s/m);
  });

  it('sibling family commands (motion / contract / skill) appear with just name + desc', async context => {
    const out = await runHelp(['--help'], context.signal);
    expect(out).toMatch(/^\s{2,}motion\s+Manage Motion/m);
    expect(out).toMatch(/^\s{2,}contract\s+Manage contracts/m);
    expect(out).toMatch(/^\s{2,}skill\s+Manage skills/m);
  });

  it('`claw --help` still goes through composer (Lifecycle group surfaces)', async context => {
    // phase 1477 已治、本 phase 不破
    const out = await runHelp(['claw', '--help'], context.signal);
    expect(out).toContain('Lifecycle:');
    expect(out).toContain('Messaging:');
    expect(out).not.toContain('<subject>');
  });

  it('watchdog exposes lifecycle commands only; daemon runs exclusively via watchdog-entry', async context => {
    const out = await runHelp(['watchdog', '--help'], context.signal);
    expect(out).toMatch(/^\s{2,}start\s{2,}Start watchdog/m);
    expect(out).toMatch(/^\s{2,}stop\s{2,}Stop watchdog/m);
    expect(out).not.toMatch(/^\s{2,}daemon\s/m);
  });

  it('rejects help-like stderr from a failed child instead of caching it as help', async context => {
    const result = await runChildProcess(process.execPath, [
      '-e', 'process.stderr.write("Usage: chestnut --help"); process.exitCode = 2;',
    ], {
      cwd: CLI_WORKSPACE,
      env: helpEnvironment(),
      timeoutMs: HELP_CASE_EXECUTION_BUDGET_MS,
      signal: context.signal,
    });
    expect(result.stderr).toContain('Usage: chestnut --help');
    expect(() => helpStdout(result)).toThrow('Help CLI exited 2');
  });
});
