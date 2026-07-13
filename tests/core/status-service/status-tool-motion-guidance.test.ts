/**
 * status-tool motion guidance injection — phase 1472 Step D.
 *
 * Covers:
 * - motion claw + composer 注入 → 输出尾段含 [CLI hints for motion] + note + verb 行
 * - 非 motion claw + composer 注入 → 0 尾段（guidance 被 motion-only guard 过滤）
 * - motion claw + 0 composer → 0 尾段（assembly 未注入时不崩 / 不写假 hint）
 *
 * 反向 1：composer 输出含 `chestnut` binary 字面（确认 composer 物理拼装）
 * 反向 2：StatusMotionGuidance.commands[0].invocation 含 `claw <name> status` verb 片段
 *        （确认业主 fact → composer 拼接链路）
 */

import { describe, it, expect, vi } from 'vitest';
import { createStatusTool } from '../../../src/core/status-service/status-tool.js';
import { composeStatusMotionGuidance } from '../../../src/assembly/motion-guidance-composer.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';

function mkCtx(clawId: string) {
  const mockFs = {
    list: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
  } as unknown as NodeFileSystem;
  return new ExecContextImpl({
    clawId,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawDir: '/tmp/test-claw',
    profile: 'full',
    fs: mockFs,
  });
}

const mockContractSystem = { loadActive: vi.fn().mockResolvedValue(null) } as any;

describe('status-tool motion guidance injection (phase 1472 Step D)', () => {
  it('motion claw + composer 注入 → 尾段含 CLI hints', async () => {
    const tool = createStatusTool(mockContractSystem, composeStatusMotionGuidance());
    const result = await tool.execute({}, mkCtx(MOTION_CLAW_ID));
    expect(result.success).toBe(true);
    expect(result.content).toContain('[CLI hints for motion]');
    expect(result.content).toContain('chestnut claw <name> status');
    expect(result.content).toContain('chestnut claw list');
  });

  it('non-motion claw + composer 注入 → 0 尾段（guard 过滤）', async () => {
    const tool = createStatusTool(mockContractSystem, composeStatusMotionGuidance());
    const result = await tool.execute({}, mkCtx('worker-claw'));
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('[CLI hints for motion]');
  });

  it('motion claw + 0 composer → 0 尾段（无 crash）', async () => {
    const tool = createStatusTool(mockContractSystem /* no guidance */);
    const result = await tool.execute({}, mkCtx(MOTION_CLAW_ID));
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('[CLI hints for motion]');
  });

  it('reverse: composer 物理拼 binary `chestnut`', () => {
    const g = composeStatusMotionGuidance();
    expect(g.commands.length).toBeGreaterThan(0);
    for (const c of g.commands) {
      expect(c.invocation.startsWith('chestnut ')).toBe(true);
    }
  });

  it('reverse: composer 含 `claw <name> status` verb fragment', () => {
    const g = composeStatusMotionGuidance();
    const statusCmd = g.commands.find((c) => c.invocation.includes('claw <name> status'));
    expect(statusCmd).toBeDefined();
    expect(statusCmd!.purpose).toContain('contract');
  });
});
