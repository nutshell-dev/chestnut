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
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const CLI_ENTRY = path.resolve(__dirname, '../../dist/cli.js');

// phase 285: cache `node CLI --help` output. 6 tests share 2 args combos
// (`--help` x5, `motion --help` x1); each spawn was ~1s, so caching brings
// the file from ~7.8s down to ~2s by going from 6 spawns to 2.
const helpCache = new Map<string, string>();
function runHelp(args: string[]): string {
  const key = args.join(' ');
  let cached = helpCache.get(key);
  if (cached === undefined) {
    const r = spawnSync('node', [CLI_ENTRY, ...args], { encoding: 'utf8' });
    cached = (r.stdout || '') + (r.stderr || '');
    helpCache.set(key, cached);
  }
  return cached;
}

describe('chestnut top-level help (phase 1488)', () => {
  it('top-level `claw` row shows only `claw` (no commander internal `[subject]`/`[args...]`)', () => {
    const out = runHelp(['--help']);
    // 顶层应有 `  claw ` 行（行起头两空格 + claw + 至少一空格 + description）
    expect(out).toMatch(/^\s{2,}claw\s{2,}Manage Claws/m);
    // 反向：旧形态字面不应出现
    expect(out).not.toContain('claw [subject]');
    expect(out).not.toContain('claw [subject] [args...]');
  });

  it('top-level `claw` description preserved', () => {
    const out = runHelp(['--help']);
    expect(out).toContain('Manage Claws (run `chestnut claw help` for full reference)');
  });

  it('motion subcommand `step <n>` positional preserved (no side-effect leak)', () => {
    const out = runHelp(['motion', '--help']);
    // 子命令层不被影响、positional `<n>` 仍显
    expect(out).toMatch(/^\s{2,}step <n>\s{2,}/m);
  });

  it('built-in `help [command]` positional preserved at top level', () => {
    const out = runHelp(['--help']);
    expect(out).toMatch(/^\s{2,}help \[command\]\s/m);
  });

  it('sibling family commands (motion / contract / skill) appear with just name + desc', () => {
    const out = runHelp(['--help']);
    expect(out).toMatch(/^\s{2,}motion\s+Manage Motion/m);
    expect(out).toMatch(/^\s{2,}contract\s+Manage contracts/m);
    expect(out).toMatch(/^\s{2,}skill\s+Manage skills/m);
  });

  it('`claw --help` still goes through composer (Lifecycle group surfaces)', () => {
    // phase 1477 已治、本 phase 不破
    const out = runHelp(['claw', '--help']);
    expect(out).toContain('Lifecycle:');
    expect(out).toContain('Messaging:');
    expect(out).not.toContain('<subject>');
  });

  it('watchdog exposes lifecycle commands only; daemon runs exclusively via watchdog-entry', () => {
    const out = runHelp(['watchdog', '--help']);
    expect(out).toMatch(/^\s{2,}start\s{2,}Start watchdog/m);
    expect(out).toMatch(/^\s{2,}stop\s{2,}Stop watchdog/m);
    expect(out).not.toMatch(/^\s{2,}daemon\s/m);
  });
});
