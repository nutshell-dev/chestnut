import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1358: subagent task scheduling capabilities', () => {
  it('owner protocols preserve typed normal and prepared submissions', () => {
    const source = read('src/core/async-task-system/types.ts');
    expect(source).toMatch(/export interface SubAgentTaskScheduler \{[\s\S]*?taskKind: 'subagent'[\s\S]*?Omit<SubAgentTask, 'id' \| 'shortId' \| 'createdAt'>[\s\S]*?\n\}/);
    expect(source).toMatch(/export interface PreparedSubAgentTaskScheduler \{[\s\S]*?taskKind: 'subagent'[\s\S]*?PreparedSubagentSchedule[\s\S]*?PreparedScheduleResult[\s\S]*?\n\}/);
  });

  it('the full system explicitly implements both capabilities', () => {
    const source = read('src/core/async-task-system/system.ts');
    expect(source).toContain('implements SubAgentTaskScheduler, PreparedSubAgentTaskScheduler');
  });

  it('normal scheduling consumers use the owner protocol, not a full class or ad-hoc Record', () => {
    for (const relative of [
      'src/core/memory/system.ts',
      'src/core/memory/random-dream.ts',
      'src/core/evolution-system/retro-scheduler.ts',
      'src/core/shadow-system/types.ts',
      'src/core/shadow-system/tools/shadow.ts',
      'src/core/spawn-system/tools/spawn.ts',
    ]) {
      const source = read(relative);
      expect(source).toContain('SubAgentTaskScheduler');
      expect(source).not.toMatch(/taskSystem\??:\s*AsyncTaskSystem/);
      expect(source).not.toMatch(/schedule\(kind: string, payload: Record<string, unknown>\)/);
    }

    // phase 1866 Step F（SU-D6）：summon 消费自有 capability（不穿透 ATS 协议名），
    // 但载荷仍是 owner 的 typed 形状、且不得退化为 ad-hoc Record / 完整类。
    const summon = read('src/core/summon-system/types.ts');
    expect(summon).toContain('export interface SummonSchedulerCapability');
    expect(summon).toContain("Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>");
    const summonTool = read('src/core/summon-system/tools/summon.ts');
    expect(summonTool).not.toContain('SubAgentTaskScheduler');
    expect(summonTool).not.toMatch(/taskSystem\??:\s*AsyncTaskSystem/);
    expect(summonTool).not.toMatch(/schedule\(kind: string, payload: Record<string, unknown>\)/);
  });

  it('Evolution durable dispatch sees only prepared scheduling', () => {
    const source = read('src/core/evolution-system/system.ts');
    expect(source).toContain('taskSystem: PreparedSubAgentTaskScheduler');
    expect(source).not.toMatch(/taskSystem:\s*AsyncTaskSystem/);
  });
});
