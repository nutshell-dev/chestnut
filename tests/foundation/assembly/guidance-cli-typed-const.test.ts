/**
 * phase 1469 invariant: composer 文件内 `chestnut X Y` 模式字面必经
 * typed const / helper 引用、不可裸字符串拼接.
 *
 * phase 1476 reframe: `CLI_COMMANDS` (verb-first 字面) → `clawCmd(id, CLAW_VERBS.X)` helper
 * (subject-first 形态) + `CONTRACT_COMMANDS.X` typed const（contract 子命令保 verb-first）.
 *
 * phase 193 Step A: regex 改抓嵌入式字面（不要求整个 string literal 是 chestnut X Y）
 * + 加 stripComments 排除注释行误报.
 *
 * phase 195 Step A: scope 扩 src/core + src/foundation（排除 cli/assembly/prompts/watchdog）
 * + 加 STEP_B_PENDING_ALLOW（exec.ts:135 + forum-formatter.ts:22 待 Step B design 审）.
 *
 * 守 M#9「不可消除的耦合应显式表达、优先表达为让编译器检查」 — typed const enable
 * 编译期 typo 检测、配 invariant runtime 兜底 surface bypass detection.
 *
 * scope：composers/<type>.ts 内任何 string literal 含 `chestnut` 前缀 + 多 token 模式 →
 * 违反；唯一豁免 = composers/index.ts（barrel）+ types.ts（NO_GUIDANCE sentinel 不含字面）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectSrc = path.resolve(__dirname, '../../../src');
const composersDir = path.resolve(__dirname, '../../../src/assembly/guidance/composers');

/** 简化注释剥离：块注释保换行、行注释删除（避免误抓 url 内 //） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

/** 递归遍历 .ts 文件 */
function walkTsFiles(dir: string, cb: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, cb);
    else if (entry.isFile() && entry.name.endsWith('.ts')) cb(full);
  }
}

// phase 195 Step B 待审 ratify 中、暂 allow（Step B 后由 follow-up phase 治 / 删此 allow）
const STEP_B_PENDING_ALLOW = new Set([
  'foundation/command-tool/exec.ts:135',
  'core/status-service/forum-formatter.ts:22',
]);

const SCAN_DIRS = ['core', 'foundation'];
const EXCLUDE_PATTERNS = [/^\/cli\//, /^\/assembly\//, /^\/prompts\//, /^\/watchdog\//, /\.test\./];

// 日志 prefix 模式：`[chestnut <namespace>]` 不抓（namespace 标识、非 CLI 命令）
const LOG_PREFIX_RE = /\[chestnut\s+\w+\]/;

describe('phase 1469: guidance composer must reference CLI via CLI_COMMANDS typed const', () => {
  it('composer files contain no bare `chestnut X Y` string literals (embedded or whole)', () => {
    const violations: Array<{ file: string; line: number; literal: string }> = [];
    const files = fs.readdirSync(composersDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');

    for (const file of files) {
      const content = fs.readFileSync(path.join(composersDir, file), 'utf-8');
      const lines = stripComments(content).split('\n');

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        // 扫该行所有 string literal（双引号 / 单引号 / 模板）
        const stringLiteralRe = /(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;
        for (const m of line.matchAll(stringLiteralRe)) {
          const literalContent = m[1] ?? m[2] ?? m[3] ?? '';
          // 在 literal 内容里找 `chestnut` 前缀模式（不要求紧贴首尾）
          const chestnutMatch = literalContent.match(/chestnut\s+\w+(?:\s+\S+)*/);
          if (chestnutMatch) {
            violations.push({ file, line: lineIdx + 1, literal: chestnutMatch[0] });
          }
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map(v => `  - ${v.file}:${v.line}: '${v.literal}'`)
        .join('\n');
      throw new Error(
        `phase 1469 invariant failed — ${violations.length} bare 'chestnut X Y' literal(s) in composer files:\n${summary}\n` +
          `Replace with clawCmd(id, CLAW_VERBS.X) helper or CONTRACT_COMMANDS.X typed const (from src/cli/commands/registry.ts).`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('src/core + src/foundation contain no bare chestnut CLI literals (M#5 violation)', () => {
    const violations: Array<{ file: string; line: number; literal: string }> = [];
    for (const subDir of SCAN_DIRS) {
      const dir = path.join(projectSrc, subDir);
      walkTsFiles(dir, file => {
        const rel = path.relative(projectSrc, file);
        if (EXCLUDE_PATTERNS.some(re => re.test('/' + rel))) return;

        const content = stripComments(fs.readFileSync(file, 'utf-8'));
        content.split('\n').forEach((line, idx) => {
          // 扫 string literal 内的 chestnut 字面、排除日志 prefix
          const stringLiteralRe = /(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;
          for (const m of line.matchAll(stringLiteralRe)) {
            const literalContent = m[1] ?? m[2] ?? m[3] ?? '';
            if (LOG_PREFIX_RE.test(literalContent)) continue;  // 排除 [chestnut spawn] 类
            const chestnutMatch = literalContent.match(/chestnut\s+\w+(?:\s+\S+)*/);
            if (chestnutMatch) {
              violations.push({ file: rel, line: idx + 1, literal: chestnutMatch[0] });
            }
          }
        });
      });
    }

    // 过滤 Step B 待审项
    const filtered = violations.filter(v => !STEP_B_PENDING_ALLOW.has(`${v.file}:${v.line}`));

    if (filtered.length > 0) {
      const summary = filtered.map(v => `  - ${v.file}:${v.line}: '${v.literal}'`).join('\n');
      throw new Error(
        `M#5 violation — ${filtered.length} bare chestnut CLI literal(s) in src/core + src/foundation:\n${summary}\n` +
          `Business modules must not contain CLI literals. Move CLI hint to CLI handler layer.`,
      );
    }
    expect(filtered).toEqual([]);
  });
});
