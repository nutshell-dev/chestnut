/**
 * Phase 1828 反向边界：inbox 系统文案单源在 src/templates/messages。
 * phase 1909 口径扩张：单源定义从「经 inbox 进入」扩为「进入智能体上下文的系统编写
 * 文案」（含 system prompt 内联片段，M16–M19）；**工具返回值里的系统文案暂不纳入**
 * （用户 2026-09-25 判定，维持 phase 1828 排除）。
 * 1. 模板目录是纯静态资源：只相对 import 目录内文件；不含时钟/随机/环境变量/动态 import。
 * 2. 迁移来源文件不再定义已迁文案（注释除外——源码历史注释不是运行双源），且确实消费模板单源。
 * 范围口径：只核《消息迁移清单》登记的来源文件；非 inbox 工具结果（如 submit_subtask 工具返回文本）与 AsyncTaskSystem 异步结果不在本 phase 范围，不算双源。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// phase 1909: M 清单数据拆出（phase 676 arch test ≤150 行 ratchet；先例 cli-guidance-boundary-cases.ts）
import { MIGRATED } from './inbox-message-template-boundary-migrated.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
const MESSAGES_DIR = path.join(SRC, 'templates/messages');
const IMPORT_SPECIFIER_RE = /(?:^|\n)\s*(?:import|export)\b[^'"]*['"]([^'"]+)['"]/g;

/** 去掉块注释与行注释（本检查只针对运行字面量；注释里的历史示例不算双源）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
}

function readStripped(rel: string): string {
  return stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
}

describe('phase 1828: inbox message template boundary', () => {
  it('templates/messages 只相对 import 自己目录（无业务/IO/第三方依赖）', () => {
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(MESSAGES_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(MESSAGES_DIR, entry.name), 'utf8');
      for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = m[1];
        const resolved = path.resolve(MESSAGES_DIR, specifier);
        if (!resolved.startsWith(MESSAGES_DIR + path.sep)) {
          offenders.push(`${entry.name}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('templates/messages 模板是纯同步函数：无时钟/随机/环境变量/动态 import', () => {
    const forbidden = [/Date\.now\(/, /Math\.random\(/, /process\.env/, /\brequire\(/, /await import\(/, /readFileSync\(/];
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(MESSAGES_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const text = stripComments(fs.readFileSync(path.join(MESSAGES_DIR, entry.name), 'utf8'));
      for (const re of forbidden) {
        if (re.test(text)) offenders.push(`${entry.name}: ${re.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  for (const source of MIGRATED) {
    it(`${source.id} ${source.file}: 不再定义已迁文案，且消费模板单源`, () => {
      const text = readStripped(source.file);
      for (const fragment of source.fragments) {
        expect(text, `${source.file} 仍含已迁文案片段: ${fragment}`).not.toContain(fragment);
      }
      expect(text, `${source.file} 未消费 templates/messages 单源`).toMatch(
        /from '[\w./-]*templates\/messages\/index\.js'/,
      );
    });
  }

  it('M01 旧位置 event-loop.ts：新旧执行提醒正文均不回流（模板调用已迁至 execution-recovery.ts）', () => {
    // phase 1845: 独立核旧文件不含新旧正文；不要求其 import 模板（不为迁就旧检查加无用 import）。
    const text = readStripped('core/event-loop/event-loop.ts');
    expect(text).not.toContain('Execution stalled with no persisted activity');
    expect(text).not.toContain('系统在检查时发现契约');
    expect(text).not.toContain('本消息用于唤醒你继续');
  });

  it('M11 退役 composer：只采用 NO_GUIDANCE，不再引用 guidance 模板（不为空 composer 保留无用 import）', () => {
    // phase 1836: composer 已无正文资源职责，从 MIGRATED 移除；定向核 NO_GUIDANCE 出口与旧 guidance 调用/模板 import 均不存在。
    const text = readStripped('assembly/guidance/composers/task-queue-overflow.ts');
    expect(text).toMatch(/export const composer = NO_GUIDANCE/);
    expect(text).not.toContain('system-level overload beyond agent control');
    expect(text).not.toContain('taskQueueOverflowGuidanceText');
    expect(text).not.toMatch(/templates\/messages/);
  });

  it('M10 旧位置 system-message-helper.ts：前缀字面定义不回流（phase 1891：文件已退化为 origin 谓词、无文案职责，照 M01 先例不加无用 import）', () => {
    expect(readStripped('foundation/messaging/system-message-helper.ts')).not.toContain("= '[system message");
  });
});
