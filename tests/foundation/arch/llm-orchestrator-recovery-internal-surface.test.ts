/**
 * Phase 2045 Step D：recovery 内部策略常量退出 llm-orchestrator barrel。
 *
 * 锁语义（逐项完整标识断言，防部分匹配误删/回流）：
 * - barrel 不再导出 6 个内部恢复策略常量（生产无外部消费者）。
 * - defaults.ts 内部定义与导出保持（模块内部策略不收缩）。
 * - 公共 recovery 能力不被误伤：createRecoverySession / LLMRecoverySchedule 仍在 barrel。
 *
 * 注：tests/core/event-loop/llm-recovery.test.ts 中同名键是 defaults.js 模块 mock
 * 覆写（vi.mock），不是 barrel 消费，不纳入本锁的删除面。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const barrelSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/index.ts', import.meta.url),
  'utf8',
);
const defaultsSource = readFileSync(
  new URL('../../../src/foundation/llm-orchestrator/defaults.ts', import.meta.url),
  'utf8',
);

const INTERNAL_RECOVERY_CONSTANTS: readonly string[] = [
  'LLM_RECOVERY_MAX_RETRIES',
  'LLM_RECOVERY_RETRY_INITIAL_DELAY_MS',
  'LLM_RECOVERY_RETRY_MAX_DELAY_MS',
  'LLM_RECOVERY_COOLDOWN_MS',
  'LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS',
  'LLM_RECOVERY_QUOTA_MAX_DELAY_MS',
];

describe('Phase 2045 Step D: llm-orchestrator recovery internal surface', () => {
  it('barrel 不再导出 6 个内部恢复策略常量（逐项完整标识）', () => {
    for (const name of INTERNAL_RECOVERY_CONSTANTS) {
      expect(barrelSource).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('defaults.ts 内部常量定义保持（模块内部策略不收缩）', () => {
    for (const name of INTERNAL_RECOVERY_CONSTANTS) {
      expect(defaultsSource).toMatch(new RegExp(`export const ${name}\\b`));
    }
  });

  it('公共 barrel 不再暴露 session/scope/begin/finish 控制面', () => {
    for (const name of [
      'createRecoverySession', 'LLMRecoverySession', 'RecoveryCallScope',
      'RecoverySessionDeps', 'callWithinRecovery', 'streamWithinRecovery',
    ]) {
      expect(barrelSource).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(barrelSource).toMatch(/LLMOrchestratorOwner/);
  });

  it('Assembly/Runtime/EventLoop 直接注入真实 owner', () => {
    const core = readFileSync(new URL('../../../src/assembly/core-infrastructure.ts', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('../../../src/assembly/runtime-assembly.ts', import.meta.url), 'utf8');
    expect(core).not.toMatch(/createRecoverySession|recoverySession|FOREGROUND_RECOVERY_SCOPE/);
    expect(runtime).toMatch(/llm: llmOwner/);
    expect(runtime).toMatch(/llmOrchestrator: llmOwner/);
    expect(runtime).toMatch(/inspectLlmRecoverySchedule: \(\) => llmOwner\.inspectRecoverySchedule\(\)/);
    expect(runtime).not.toMatch(/recoverySession/);
  });
});
