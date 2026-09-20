/**
 * phase 1879 Step D (cli-audit-scope-migration-remainder): 命令文件侧 audit 创建点清零 source-scan。
 *
 * 1874 Step I 已立 CliActionScope + actionAuditFor（有 scope 走 scope、无 scope 回落裸创建）；
 * 本 Step 把 src/cli/commands/ 下全部 createDirContext/createSystemAudit 直用点迁到
 * actionAuditFor，完成「逐步迁移」第二段。
 *
 * 白名单：src/cli/action-scope.ts（scope 实现自身，1874 I 的唯一定点）。
 * 形态对齐 tests/cli/steps-hint-invariant.test.ts 的 src source-scan 先例。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function listCommandSources(): string[] {
  const dir = path.join(ROOT, 'src/cli/commands');
  return fs.readdirSync(dir)
    .filter((e) => e.endsWith('.ts'))
    .map((e) => `src/cli/commands/${e}`);
}

describe('phase 1879 Step D: 命令文件侧 audit 创建点统一经 actionAuditFor', () => {
  it('src/cli/commands/*.ts 零 createDirContext/createSystemAudit 调用点（含 import）', () => {
    const violations: string[] = [];
    for (const rel of listCommandSources()) {
      const src = readSrc(rel);
      for (const [i, line] of src.split('\n').entries()) {
        // 注释行豁免（登记/说明性提及），其余一律违规
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (/\bcreateDirContext\b|\bcreateSystemAudit\b/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('白名单唯一：createDirContext 只剩 action-scope.ts（scope 实现）与 foundation/audit 自家', () => {
    const cliRoot = path.join(ROOT, 'src/cli');
    const violations: string[] = [];
    for (const entry of fs.readdirSync(cliRoot)) {
      if (!entry.endsWith('.ts') || entry === 'action-scope.ts') continue;
      const src = readSrc(`src/cli/${entry}`);
      for (const [i, line] of src.split('\n').entries()) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (/\bcreateDirContext\b|\bcreateSystemAudit\b/.test(line)) {
          violations.push(`src/cli/${entry}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('迁移命令均消费 actionAuditFor（抽样锚点核对）', () => {
    const expected = [
      'claw-health.ts', 'motion.ts', 'claw-daemon.ts', 'motion-daemon.ts',
      'config.ts', 'status.ts', 'start.ts', 'claw-router.ts',
      'claw-send.ts', 'claw-list.ts', 'claw-stream.ts', 'contract-helpers.ts', 'stop.ts',
    ];
    for (const file of expected) {
      const src = readSrc(`src/cli/commands/${file}`);
      expect(src, file).toContain('actionAuditFor(');
      expect(src, file).toContain("from '../action-scope.js'");
    }
  });
});
