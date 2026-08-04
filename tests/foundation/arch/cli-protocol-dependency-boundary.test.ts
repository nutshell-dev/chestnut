/**
 * Phase 1283 Step C: CLIProtocol dependency boundary ratchet。
 *
 * 从 cli-guidance-boundary.test.ts 拆出（phase 1283 Step A 追加 zod allowlist 后
 * 原文件超 150 行 arch ratchet）：CLIProtocol（src/cli-protocol/**）模块级依赖约束
 * 独立成文件——relative import 解析后必须仍位于 src/cli-protocol/ 内；bare
 * specifier 只放行 schema 库 zod（非 Chestnut 实现模块），其余 bare 一律违规。
 * scanner 原语复用 cli-guidance-boundary-helpers.js，验收决策留在本文件。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLI_PROTOCOL_DIR,
  IMPORT_SPECIFIER_RE,
  relativeToSrc,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

/** CLIProtocol 允许的 bare specifier（schema 库、非 Chestnut 实现模块）。 */
const ALLOWED_BARE_SPECIFIERS = new Set(['zod']);

/** 收集 dir 下违规 import：非 allowlist bare、或解析后逃逸 src/cli-protocol/ 的 relative。 */
function collectDependencyViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const file of walkTsFiles(dir)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = m[1];
      if (!specifier.startsWith('.')) {
        if (!ALLOWED_BARE_SPECIFIERS.has(specifier)) {
          violations.push(`${relativeToSrc(file)}: external specifier '${specifier}'`);
        }
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(CLI_PROTOCOL_DIR + path.sep) && resolved !== CLI_PROTOCOL_DIR) {
        violations.push(`${relativeToSrc(file)}: escapes cli-protocol via '${specifier}'`);
      }
    }
  }
  return violations;
}

/** 单 specifier 按 production scanner 同规则判定是否违规（供反向断言）。 */
function isViolation(specifier: string): boolean {
  if (!specifier.startsWith('.')) return !ALLOWED_BARE_SPECIFIERS.has(specifier);
  const resolved = path.resolve(CLI_PROTOCOL_DIR, specifier);
  return !resolved.startsWith(CLI_PROTOCOL_DIR + path.sep) && resolved !== CLI_PROTOCOL_DIR;
}

describe('phase 1283 Step C: CLIProtocol dependency boundary', () => {
  it('CLIProtocol 零 Chestnut 实现依赖：production 扫描零违规', () => {
    expect(collectDependencyViolations(CLI_PROTOCOL_DIR)).toEqual([]);
  });

  it('bare specifier 只放行 zod，不整族放行 bare package', () => {
    expect([...ALLOWED_BARE_SPECIFIERS]).toEqual(['zod']);
  });

  it('反向断言：zod 允许、commander 拒绝、逃逸 relative 拒绝、同模块 relative 允许', () => {
    expect(isViolation('zod')).toBe(false);
    expect(isViolation('commander')).toBe(true); // commander 非 allowlist bare → 违规
    expect(isViolation('../assembly/index.js')).toBe(true);
    expect(isViolation('./invocation.js')).toBe(false);
    // scanner 对两类 specifier 的识别自证（mixed / type-only 形态同 IMPORT_SPECIFIER_RE）
    const escape = [...'import { x } from \'../assembly/index.js\';'.matchAll(IMPORT_SPECIFIER_RE)];
    expect(escape).toHaveLength(1);
    expect(isViolation(escape[0][1])).toBe(true);
  });
});
