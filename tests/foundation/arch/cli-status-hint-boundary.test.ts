/**
 * Phase 1278 Step A: claw status hint boundary ratchet.
 *
 * 锁 `formatClawStatusHint` 归位 CLIProtocol 后的边界（总览反向验收 1/2/3/5）：
 *  - 唯一实现归 `src/cli-protocol/claw-status-hint.ts`，经 public barrel 公开；
 *  - 旧 CLIProcess owner（src/cli/**）零定义 / 零 re-export 同名符号；
 *  - Assembly 对该符号的消费恰经 CLIProtocol public barrel（禁 deep import 内部文件）；
 *  - src/core/** 零 cli-protocol import（ClawTopology 只见结构 callback port，不见 L6 模块路径）。
 * scanner 原语复用 cli-guidance-boundary-helpers.js；正反 fixture 自证，
 * 避免只对当前源码做脆弱 grep。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLI_PROTOCOL_DIR,
  IMPORT_SPECIFIER_RE,
  assemblyDir,
  relativeToSrc,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(CLI_PROTOCOL_DIR, '..');
const CLI_DIR = path.join(SRC_ROOT, 'cli');
const CORE_DIR = path.join(SRC_ROOT, 'core');
const MOTION_ADDONS = path.join(SRC_ROOT, 'assembly', 'motion-addons.ts');

/** 简化注释剥离：块注释保换行、行注释删除（与 guidance-cli-typed-const 同型）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

/** export 语句定义或转导 formatClawStatusHint（含 named re-export / export * 旧文件 / 本地定义）。 */
const EXPORT_SYMBOL_RE = /export\s+(?:type\s+)?(?:function|const|let|var)\s+formatClawStatusHint\b/;
const EXPORT_NAMED_RE = /export\s+(?:type\s+)?\{[^}]*\bformatClawStatusHint\b[^}]*\}/;
const EXPORT_STAR_OLD_OWNER_RE = /export\s*\*\s*from\s*['"][^'"]*claw-status-hints(\.js|\.ts)?['"]/;

/** import/export clause 携带 formatClawStatusHint 时抓其 specifier。 */
function symbolSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
    if (/\bformatClawStatusHint\b/.test(m[0])) out.push(m[1]);
  }
  return out;
}

describe('phase 1278 Step A: claw status hint boundary（formatter 唯一 owner = CLIProtocol）', () => {
  it('CLIProtocol public barrel 公开 formatClawStatusHint（唯一消费入口）', () => {
    const barrel = fs.readFileSync(path.join(CLI_PROTOCOL_DIR, 'index.ts'), 'utf8');
    const specifiers = symbolSpecifiers(barrel);
    expect(specifiers).toEqual(['./claw-status-hint.js']);
    const impl = fs.readFileSync(path.join(CLI_PROTOCOL_DIR, 'claw-status-hint.ts'), 'utf8');
    expect(impl).toMatch(EXPORT_SYMBOL_RE);
  });

  it('旧 CLIProcess owner 清零：src/cli/** 零定义 / 零 re-export formatClawStatusHint', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(CLI_DIR)) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (EXPORT_SYMBOL_RE.test(text) || EXPORT_NAMED_RE.test(text) || EXPORT_STAR_OLD_OWNER_RE.test(text)) {
        violations.push(relativeToSrc(file));
      }
    }
    expect(violations).toEqual([]);
    // 旧 owner 文件本身不得再持有该符号（注释剥离后任何引用一律不允许）
    const oldOwner = stripComments(fs.readFileSync(path.join(CLI_DIR, 'utils', 'claw-status-hints.ts'), 'utf8'));
    expect(oldOwner.includes('formatClawStatusHint')).toBe(false);
  });

  it('Assembly 恰经 CLIProtocol public barrel 消费（motion-addons specifier 锁定 + 零 deep import）', () => {
    const text = fs.readFileSync(MOTION_ADDONS, 'utf8');
    expect(symbolSpecifiers(text)).toEqual(['../cli-protocol/index.js']);
    const deepImports: string[] = [];
    for (const file of walkTsFiles(assemblyDir())) {
      for (const specifier of symbolSpecifiers(stripComments(fs.readFileSync(file, 'utf8')))) {
        if (!/(?:^|\/)cli-protocol\/index\.js$/.test(specifier)) {
          deepImports.push(`${relativeToSrc(file)}: '${specifier}'`);
        }
      }
    }
    expect(deepImports).toEqual([]);
    // Assembly 不得再从旧 CLIProcess 路径取得该 formatter
    const oldEdge: string[] = [];
    for (const file of walkTsFiles(assemblyDir())) {
      for (const m of stripComments(fs.readFileSync(file, 'utf8')).matchAll(IMPORT_SPECIFIER_RE)) {
        if (/cli\/utils\/claw-status-hints/.test(m[1])) oldEdge.push(`${relativeToSrc(file)}: '${m[1]}'`);
      }
    }
    expect(oldEdge).toEqual([]);
  });

  it('src/core/** 零 cli-protocol import（ClawTopology 只见 callback port，不见 L6）', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(CORE_DIR)) {
      for (const m of stripComments(fs.readFileSync(file, 'utf8')).matchAll(IMPORT_SPECIFIER_RE)) {
        if (/cli-protocol/.test(m[1])) violations.push(`${relativeToSrc(file)}: '${m[1]}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('反向 fixture：scanner 能检出违反形态、不误放合法形态', () => {
    // export 定义 / named re-export / export * 旧 owner 均检出
    expect(EXPORT_SYMBOL_RE.test('export function formatClawStatusHint(n: string, a: boolean) {')).toBe(true);
    expect(EXPORT_NAMED_RE.test("export { formatClawStatusHint } from '../utils/claw-status-hints.js';")).toBe(true);
    expect(EXPORT_NAMED_RE.test("export { formatClawStatusHint, formatNoActiveContractHint } from '../utils/claw-status-hints.js';")).toBe(true);
    expect(EXPORT_STAR_OLD_OWNER_RE.test("export * from '../utils/claw-status-hints.js';")).toBe(true);
    expect(EXPORT_STAR_OLD_OWNER_RE.test("export * from 'src/cli/utils/claw-status-hints.js';")).toBe(true);
    // 合法形态不误报：type-only 提及、消费者 import、旧文件内另一 formatter 的 export
    expect(EXPORT_NAMED_RE.test("export { formatNoActiveContractHint } from '../utils/claw-status-hints.js';")).toBe(false);
    expect(EXPORT_SYMBOL_RE.test('formatClawStatusHint: (clawName: string, isAlive: boolean) => string | undefined;')).toBe(false);
    expect(EXPORT_SYMBOL_RE.test("import { formatClawStatusHint } from '../../cli-protocol/index.js';")).toBe(false);

    // symbol specifier 抓取：deep import 与 barrel 形态区分
    expect(symbolSpecifiers("import { formatClawStatusHint } from '../cli-protocol/claw-status-hint.js';"))
      .toEqual(['../cli-protocol/claw-status-hint.js']);
    expect(symbolSpecifiers("import { formatClawStatusHint } from '../cli-protocol/index.js';"))
      .toEqual(['../cli-protocol/index.js']);
    expect(symbolSpecifiers("export { formatClawStatusHint } from './claw-status-hint.js';"))
      .toEqual(['./claw-status-hint.js']);
    // 不携带该符号的 import 不抓
    expect(symbolSpecifiers("import { formatNoActiveContractHint } from './claw-shared.js';")).toEqual([]);
    // barrel specifier 判定：相对 / 深链形态
    expect(/(?:^|\/)cli-protocol\/index\.js$/.test('../../../cli-protocol/index.js')).toBe(true);
    expect(/(?:^|\/)cli-protocol\/index\.js$/.test('../cli-protocol/claw-status-hint.js')).toBe(false);
  });
});
