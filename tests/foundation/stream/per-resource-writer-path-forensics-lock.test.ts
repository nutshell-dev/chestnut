/**
 * Phase 1189 r130 E fork β-4: PerResourceStreamWriter path forensics 现状 lock
 *
 * 应然：path 字段是 audit emit STREAM_AUDIT_EVENTS.APPEND_FAILED 的 forensics 关键 col
 *       caller convention 应保证 path 含 agent/claw/task 标识便于 root cause 定位
 * 实然 (phase 1189 Step A Path #1 实测):
 *   - subagent-executor.ts:101  path = `${taskResultDir}/${STREAM_FILE}`  含 task 标识 forensics OK
 *   - subagent/run.ts:86         path = `${opts.resultDir}/${STREAM_FILE}` 含 agent 标识 forensics OK
 *   - cli/commands/contract.ts:45 path = STREAM_FILE literal              无 clawId 前缀 真 gap
 * 本测 = 锁现状 + 标 cli/contract gap 推 r131+ 业务决策 phase 修
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerResourceStreamWriter } from '../../../src/foundation/stream/per-resource-writer.js';
import { STREAM_AUDIT_EVENTS } from '../../../src/foundation/stream/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(): FileSystem {
  return {
    appendSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
    moveSync: vi.fn(),
    existsSync: vi.fn(() => false),
    listSync: vi.fn(() => []),
    readSync: vi.fn(() => ''),
    writeAtomicSync: vi.fn(),
    ensureDirSync: vi.fn(),
    deleteSync: vi.fn(),
  } as unknown as FileSystem;
}

function makeAudit() {
  const events: Array<[string, ...string[]]> = [];
  return {
    write: vi.fn((type: string, ...cols: string[]) => events.push([type, ...cols])),
    events,
  };
}

describe('PerResourceStreamWriter path forensics lock (phase 1189 β-4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 反向 1：含 agent-id path → forensics 完整
  it('caller convention 1: path 含 agent identifier → audit emit path 字段含 agent-id 子串', () => {
    const fs = makeMockFs();
    (fs.appendSync as any).mockImplementation(() => { throw new Error('disk full'); });
    const audit = makeAudit();
    const writer = new PerResourceStreamWriter(
      fs,
      '/tmp/agents/agent-xyz/stream.jsonl',  // mirror subagent/run.ts:86 pattern
      audit as any,
    );
    writer.write({ ts: 1, type: 'test' });
    expect(audit.events.length).toBe(1);
    expect(audit.events[0][0]).toBe(STREAM_AUDIT_EVENTS.APPEND_FAILED);
    const pathCol = audit.events[0].find(c => c.startsWith('path='));
    expect(pathCol).toBeDefined();
    expect(pathCol).toContain('agent-xyz');  // forensics 完整
  });

  // 反向 2：含 task-id path → forensics 完整
  it('caller convention 2: path 含 task identifier → audit emit path 字段含 task-id 子串', () => {
    const fs = makeMockFs();
    (fs.appendSync as any).mockImplementation(() => { throw new Error('disk full'); });
    const audit = makeAudit();
    const writer = new PerResourceStreamWriter(
      fs,
      '/tmp/tasks/task-abc/stream.jsonl',  // mirror subagent-executor.ts:101 pattern
      audit as any,
    );
    writer.write({ ts: 1, type: 'test' });
    const pathCol = audit.events[0].find(c => c.startsWith('path='));
    expect(pathCol).toContain('task-abc');  // forensics 完整
  });

  // 反向 3：cli/contract literal path → forensics gap 标 anchor 推 r131+ 真治
  // 本测锁现状不修真 gap（gap 修属业务决策推 r131+ 独立 phase）
  it('caller convention 3 (gap anchor): cli/contract STREAM_FILE literal path → audit emit path 字段 = 仅 file name 无 clawId', () => {
    const fs = makeMockFs();
    (fs.appendSync as any).mockImplementation(() => { throw new Error('disk full'); });
    const audit = makeAudit();
    const writer = new PerResourceStreamWriter(
      fs,
      'stream.jsonl',  // mirror cli/commands/contract.ts:45 literal pattern
      audit as any,
    );
    writer.write({ ts: 1, type: 'user_notify' });
    const pathCol = audit.events[0].find(c => c.startsWith('path='));
    expect(pathCol).toBe('path=stream.jsonl');  // 锁现状：literal 不含 claw-id
    // 升档锚 (c): 当真用例需 clawId 定位 root cause 时本测 should be 反转为 .toContain('claw-')
    // → 推 r131+ 业务决策 phase 修 cli/commands/contract.ts:45 path 含 clawId 前缀
  });
});
