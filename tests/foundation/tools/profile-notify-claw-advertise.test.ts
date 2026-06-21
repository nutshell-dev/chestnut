/**
 * Phase 894 r115 B fork (NEW.P0.1):
 * 端到端反向验证 — notify_claw 经 ToolRegistry.getForProfile('full') + formatForLLM 真送达 LLM tools 数组。
 *
 * 防回归点：register-only 而 profile 漏 entry 时（phase 822 DOA 反模式 N=1）LLM 工具列表静默 0 notify_claw。
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { createNotifyClawTool } from '../../../src/foundation/messaging/tools/notify-claw.js';

describe('phase 894 NEW.P0.1 — notify_claw profile advertise pipeline', () => {
  it('motion runtime (profile=full) gets notify_claw in LLM tools array', async () => {
    const registry = new ToolRegistryImpl();
    // 最小 fs / audit mock（仅满足 createNotifyClawTool factory ctor、不调实际 invoke）
    const fakeFs = {} as any;
    const fakeAudit = { write: () => {} } as any;
    registry.register(createNotifyClawTool({
      fs: fakeFs,
      chestnutRoot: '/tmp/forum',
      defaultSource: 'motion', isCallerAuthorized: (label: string) => label === 'motion',
      audit: fakeAudit,
      isClawAlive: () => true,
      formatClawStatusHint: () => undefined,
      clawExists: () => true,
      hasActiveContract: () => false,
    }));

    const fullTools = registry.getForProfile('full');
    const llmTools = registry.formatForLLM(fullTools);
    const names = llmTools.map(t => t.name);

    expect(names).toContain('notify_claw');
  });

  it('non-motion profiles do NOT advertise notify_claw', async () => {
    const registry = new ToolRegistryImpl();
    const fakeFs = {} as any;
    const fakeAudit = { write: () => {} } as any;
    registry.register(createNotifyClawTool({
      fs: fakeFs,
      chestnutRoot: '/tmp/forum',
      defaultSource: 'motion', isCallerAuthorized: (label: string) => label === 'motion',
      audit: fakeAudit,
      isClawAlive: () => true,
      formatClawStatusHint: () => undefined,
      clawExists: () => true,
      hasActiveContract: () => false,
    }));

    for (const profile of ['readonly', 'subagent', 'miner'] as const) {
      const tools = registry.getForProfile(profile);
      const names = registry.formatForLLM(tools).map(t => t.name);
      expect(names).not.toContain('notify_claw');
    }
  });
});
