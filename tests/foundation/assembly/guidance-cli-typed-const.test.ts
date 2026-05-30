/**
 * phase 1469 invariant: composer 文件内 `clawforum X Y` 模式字面必经
 * CLI_COMMANDS typed const 引用、不可裸字符串拼接.
 *
 * 守 ML#9「不可消除的耦合应显式表达、优先表达为让编译器检查」 — typed const enable
 * 编译期 typo 检测、配 invariant runtime 兜底 surface bypass detection.
 *
 * scope：composers/<type>.ts 内任何 string literal 含 `clawforum` 前缀 + 多 token 模式 →
 * 违反；唯一豁免 = composers/index.ts（barrel）+ types.ts（NO_GUIDANCE sentinel 不含字面）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composersDir = path.resolve(__dirname, '../../../src/assembly/guidance/composers');

describe('phase 1469: guidance composer must reference CLI via CLI_COMMANDS typed const', () => {
  it('composer files contain no bare `clawforum X Y` string literals', () => {
    const violations: Array<{ file: string; line: number; literal: string }> = [];
    const files = fs.readdirSync(composersDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');
    for (const file of files) {
      const content = fs.readFileSync(path.join(composersDir, file), 'utf-8');
      // 扫所有 string literal（单引号 / 双引号 / 模板字符串） 含 `clawforum X Y` 模式
      const re = /['"`](clawforum\s+\w+(?:\s+\w+)*)['"`]/g;
      for (const m of content.matchAll(re)) {
        const before = content.slice(0, m.index ?? 0);
        const line = before.split('\n').length;
        violations.push({ file, line, literal: m[1] });
      }
    }
    if (violations.length > 0) {
      const summary = violations
        .map(v => `  - ${v.file}:${v.line}: '${v.literal}'`)
        .join('\n');
      throw new Error(
        `phase 1469 invariant failed — ${violations.length} bare 'clawforum X Y' literal(s) in composer files:\n${summary}\n` +
          `Replace with CLI_COMMANDS.* typed const reference (from src/cli/commands/registry.ts).`,
      );
    }
    expect(violations).toEqual([]);
  });
});
