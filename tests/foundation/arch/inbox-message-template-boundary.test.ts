/**
 * Phase 1828 反向边界：inbox 系统文案单源在 src/templates/messages。
 * 1. 模板目录是纯静态资源：只相对 import 目录内文件；不含时钟/随机/环境变量/动态 import。
 * 2. 迁移来源文件不再定义已迁文案（注释除外——源码历史注释不是运行双源）。
 * 3. 迁移来源文件确实消费模板单源（import 自 templates/messages）。
 * 范围口径：只核《消息迁移清单》登记的来源文件；非 inbox 工具结果（如 submit_subtask
 * 工具返回文本）与 AsyncTaskSystem 异步结果不在本 phase 范围，不算双源。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface MigratedSource {
  id: string;
  file: string;
  /** 迁移前该文件内的特征文案片段（注释剥离后不应再出现）。 */
  fragments: string[];
}

const MIGRATED: MigratedSource[] = [
  {
    id: 'M01',
    // phase 1845: 真实消费者是 controller（execution-recovery.ts）；旧 event-loop.ts
    // 位置由独立检查核正文不回流，不要求其 import 模板。新语义片段同样不得在
    // 模板外定义第二份（旧英文保留防回潮）。
    file: 'core/event-loop/execution-recovery.ts',
    fragments: [
      'Execution stalled with no persisted activity',
      '系统在检查时发现契约',
      '本消息用于唤醒你继续',
    ],
  },
  {
    id: 'M02',
    file: 'daemon/daemon-loop.ts',
    // phase 1839: 新语义正文片段同样不得在模板外定义第二份（旧 fragment 保留防回潮）
    fragments: [
      'System startup. Please review active contracts',
      '执行进程已启动',
      '启动检查时发现仍有活跃契约',
      '继续尚未完成的工作',
    ],
  },
  {
    id: 'M03',
    file: 'core/contract/verification-notify.ts',
    // phase 1829: 新语义文案同样不得在模板外定义第二份
    fragments: [
      'accepted. All subtasks complete!', 'No feedback provided', 'force-accepted after',
      'Acceptance verification failed with error', 'Acceptance verifier timed out after',
      'Acceptance verification crashed (system bug)',
      '本次验收未通过', '契约验收通知', '本次验收流程异常', '按现行规则将该子任务记为完成',
    ],
  },
  {
    id: 'M03', file: 'core/contract/verification.ts',
    fragments: ['verification config script 类型缺少', 'verification config llm 类型缺少', '本次验收'],
  },
  { id: 'M03', file: 'core/contract/verification-format.ts', fragments: ['未提供具体问题', '需要修正的问题', '验收标准', '已失败'] },
  {
    id: 'M03', file: 'core/contract/verification-execution.ts',
    fragments: ['路径安全拒绝', 'LLM 验收未配置', '验收子代理超时', 'Script verification passed', 'LLM 验收失败', 'prompt_file 读失败'],
  },
  { id: 'M04', file: 'assembly/contract-notification-adapter.ts', fragments: ['claw=${deps.clawId} ${formatNotifyData(data)}'] },
  {
    id: 'M05',
    file: 'core/contract/jobs/event-collector.ts',
    fragments: [
      '[contract_completed] claw=',
      '[contract_cancelled] claw=',
      '[contract_failed] claw=',
      '[contract_crashed] claw=',
      '[contract_archive_corrupted] claw=',
      'subtasks (completed before cancel)',
      'subtasks (completed before crash)',
      '⚠ last_failure:',
    ],
  },
  { id: 'M05', file: 'core/contract/jobs/contract-observer.ts', fragments: [".join('\\n\\n')"] },
  { id: 'M06', file: 'core/contract/contract-auditor.ts', fragments: ['看了你最近的活动', '（auditor 标 drift 但未给具体条目）', '（无）'] },
  {
    id: 'M07',
    file: 'core/claw-topology/jobs/outbox-summary/write.ts',
    fragments: ['outbox 未读：共', '（无预览）', '〔提示〕以上未读消息与此前推送完全重复', '计数可能不完整'],
  },
  { id: 'M08', file: 'core/heartbeat/inbox-formatter.ts', fragments: ['Heartbeat triggered. Please perform a routine check.'] },
  {
    id: 'M09',
    file: 'core/memory/random-dream.ts',
    // phase 1835: 新语义文案同样不得在模板外定义第二份（旧英文保留防回退）
    fragments: [
      'Dream outputs persisted',
      '跨 claw 经验探索输出已保存',
      '产物：',
      '尚未自动整理为可检索的长期记忆',
    ],
  },
  { id: 'M10', file: 'foundation/messaging/formatter-registry.ts', fragments: ['[system message${', '[user inbox message${'] },
  { id: 'M10', file: 'foundation/messaging/system-message-helper.ts', fragments: ["= '[system message'"] },
  {
    id: 'M11',
    file: 'core/async-task-system/system.ts',
    // phase 1836: 新语义文案同样不得在模板外定义第二份（旧英文保留防回退）
    fragments: [
      'Task queue is at capacity',
      '因待处理队列超限被拒绝',
      '检查时队列数量',
      '系统已将该任务记为失败',
    ],
  },
];

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
    // phase 1845: 独立核旧文件不含新旧正文；不再要求该文件 import 模板（真实消费
    // 者是 execution-recovery.ts，不为迁就旧检查给 event-loop.ts 加无用 import）。
    const text = readStripped('core/event-loop/event-loop.ts');
    expect(text).not.toContain('Execution stalled with no persisted activity');
    expect(text).not.toContain('系统在检查时发现契约');
    expect(text).not.toContain('本消息用于唤醒你继续');
  });

  it('M11 退役 composer：只采用 NO_GUIDANCE，不再引用 guidance 模板（不为空 composer 保留无用 import）', () => {
    // phase 1836: composer 已无正文资源职责，从 MIGRATED 移除；定向核 NO_GUIDANCE 出口
    // 与旧 guidance 调用/模板 import 均不存在。
    const text = readStripped('assembly/guidance/composers/task-queue-overflow.ts');
    expect(text).toMatch(/export const composer = NO_GUIDANCE/);
    expect(text).not.toContain('system-level overload beyond agent control');
    expect(text).not.toContain('taskQueueOverflowGuidanceText');
    expect(text).not.toMatch(/templates\/messages/);
  });
});
