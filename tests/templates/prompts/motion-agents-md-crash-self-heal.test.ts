/**
 * Motion AGENTS.md crash self-heal smoke test — phase 1380 rewrite.
 *
 * phase 1380: 崩溃自愈决策树删除、改为「系统自动处理」一句；claw_crashed 通知退场。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.resolve(__dirname, '../../../src/templates/motion/AGENTS.md');

describe('motion AGENTS.md crash self-heal (phase 1380: 系统自动重启、不教决策树)', () => {
  const content = fs.readFileSync(AGENTS_PATH, 'utf-8');

  it('崩溃自愈段 = 系统自动处理一句、无决策树', () => {
    expect(content).toContain('执行单元的进程崩溃由系统（Watchdog）自动重启恢复，你无需处理。');
    expect(content).not.toContain('同 source claw_crashed');
    expect(content).not.toContain('claw_crashed');
  });

  it('管理指令快速参考不再教重启 daemon（claw <id> daemon 行删除）', () => {
    expect(content).not.toContain('chestnut claw <claw-id> daemon');
  });

  it('信息来源不再含崩溃通知措辞', () => {
    expect(content).not.toContain('崩溃通知');
  });

  it('phase 1392: 管理指令节 = 任务管理、0 claw 健康管理教学', () => {
    expect(content).toContain('chestnut contract cancel <id>');
    expect(content).not.toContain('chestnut claw <claw-id> status');
    expect(content).not.toContain('chestnut claw <claw-id> health');
    expect(content).not.toContain('chestnut claw <claw-id> stop');
    expect(content).not.toContain('chestnut claw list');
  });

  it('phase 1392: summon = 异步函数心智模型教学（无 claw 分工教学）', () => {
    expect(content).toContain('summon = 异步函数调用');
    expect(content).not.toContain('为 claw');
    expect(content).not.toContain('多 Claw 架构');
  });
});
