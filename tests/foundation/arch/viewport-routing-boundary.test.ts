/**
 * Phase 1279 Step A: viewport audit routing boundary ratchet.
 *
 * 锁 viewport routing 归位真实 CLI 进程后的边界（总览反向验收 1/2/5）：
 *  - Assembly（src/assembly 与 tests/assembly）对 viewport routing owner 零依赖：
 *    零 viewport-audit-events import specifier、零 VIEWPORT_FILE_ROUTING 引用；
 *  - 两个真实 chat 入口（motion chat / claw chat）恰经 owner 工厂
 *    createViewportAudit 接线，且不各自复制 Record→Map routing 转换（M#7/M#8）；
 *  - createViewportAudit 唯一定义于 owner 模块 viewport-audit-events.ts。
 * scanner 原语复用 cli-guidance-boundary-helpers.js；正反 fixture 自证，
 * 避免只对当前源码做脆弱 grep。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IMPORT_SPECIFIER_RE,
  assemblyDir,
  relativeToSrc,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const CLI_COMMANDS_DIR = path.join(SRC_ROOT, 'cli', 'commands');
const TESTS_ASSEMBLY_DIR = path.join(PROJECT_ROOT, 'tests', 'assembly');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const OWNER_MODULE = 'viewport-audit-events';
const ROUTING_SYMBOL = 'VIEWPORT_FILE_ROUTING';
const FACTORY_SYMBOL = 'createViewportAudit';

/** 简化注释剥离：块注释保换行、行注释删除（与 cli-status-hint-boundary 同型）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

/**
 * 扫描 dir 下 .ts 文件对 viewport routing owner 的依赖：
 * import/export specifier 命中 viewport-audit-events，或注释剥离后引用
 * VIEWPORT_FILE_ROUTING。返回违规的 projectRoot 相对路径。
 */
function scanViewportRoutingRefs(dir: string, relativeBase: string): string[] {
  const violations: string[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    let hit = false;
    for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
      if (m[1].includes(OWNER_MODULE)) hit = true;
    }
    if (text.includes(ROUTING_SYMBOL)) hit = true;
    if (hit) violations.push(path.relative(relativeBase, file));
  }
  return violations;
}

/** 入口接线判定：import owner 模块且调用 createViewportAudit(。 */
function entryWiredViaOwnerFactory(text: string): boolean {
  const stripped = stripComments(text);
  let importsOwner = false;
  for (const m of stripped.matchAll(IMPORT_SPECIFIER_RE)) {
    if (m[1].includes(OWNER_MODULE) && m[0].includes(FACTORY_SYMBOL)) importsOwner = true;
  }
  return importsOwner && new RegExp(`${FACTORY_SYMBOL}\\(`).test(stripped);
}

describe('phase 1279 Step A: viewport routing boundary（owner = CLI Chat Viewport）', () => {
  it('Assembly 零 viewport routing 依赖（src/assembly 与 tests/assembly）', () => {
    expect(scanViewportRoutingRefs(assemblyDir(), PROJECT_ROOT)).toEqual([]);
    expect(scanViewportRoutingRefs(TESTS_ASSEMBLY_DIR, PROJECT_ROOT)).toEqual([]);
  });

  it('两真实 chat 入口恰经 owner 工厂 createViewportAudit 接线', () => {
    for (const entry of ['motion.ts', 'claw-chat.ts']) {
      const text = fs.readFileSync(path.join(CLI_COMMANDS_DIR, entry), 'utf8');
      expect(entryWiredViaOwnerFactory(text), `${entry} must call ${FACTORY_SYMBOL}`).toBe(true);
      // 入口不得各自复制 routing 转换（转换唯一归 owner 工厂）
      expect(stripComments(text).includes(ROUTING_SYMBOL), `${entry} must not reference ${ROUTING_SYMBOL}`).toBe(false);
    }
  });

  it('createViewportAudit 唯一定义于 owner 模块', () => {
    const definitions: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (new RegExp(`export\\s+function\\s+${FACTORY_SYMBOL}\\b`).test(text)) {
        definitions.push(relativeToSrc(file));
      }
    }
    expect(definitions).toEqual([path.join('cli', 'commands', 'viewport-audit-events.ts')]);
  });

  it('scanner 正反 fixture 自证', () => {
    const hits = scanViewportRoutingRefs(FIXTURES_DIR, PROJECT_ROOT);
    expect(hits).toContain('tests/foundation/arch/fixtures/assembly-viewport-routing-import-violation.ts');
    expect(hits).not.toContain('tests/foundation/arch/fixtures/assembly-viewport-routing-clean.ts');
    // 接线判定的反例：violation fixture 有 import 但无工厂调用 → 不算接线
    const violation = fs.readFileSync(
      path.join(FIXTURES_DIR, 'assembly-viewport-routing-import-violation.ts'), 'utf8');
    expect(entryWiredViaOwnerFactory(violation)).toBe(false);
  });
});
