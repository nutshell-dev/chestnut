import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  LLMCallCapability,
  LLMOrchestrator,
  LLMOrchestratorOwner,
  LLMRuntimeCapability,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type { SubagentTaskExecutorDeps } from '../../../src/assembly/subagent-task-executor.js';

const read = (relative: string): string => readFileSync(
  new URL(`../../../${relative}`, import.meta.url),
  'utf8',
);

describe('phase 2052 Step E: LLM execution, runtime management and owner capabilities', () => {
  it('业务执行面仅 call/stream/getProviderInfo，call-only 面仅 call', () => {
    expectTypeOf<keyof LLMCallCapability>().toEqualTypeOf<'call'>();
    expectTypeOf<keyof LLMOrchestrator>().toEqualTypeOf<'call' | 'stream' | 'getProviderInfo'>();
    expectTypeOf<LLMCallCapability>().not.toHaveProperty('stream');
    expectTypeOf<LLMCallCapability>().not.toHaveProperty('getProviderInfo');
    for (const method of [
      'healthCheck',
      'getFailureDisposition',
      'resetLastSuccessProvider',
      'close',
      'reloadConfig',
      'getSharedRecoveryDecision',
      'callWithinRecovery',
      'streamWithinRecovery',
    ] as const) {
      expectTypeOf<LLMOrchestrator>().not.toHaveProperty(method);
    }
  });

  it('Owner 显式保留执行面、Runtime 五方法及恢复/健康能力', () => {
    expectTypeOf<LLMOrchestratorOwner>().toMatchTypeOf<LLMOrchestrator>();
    expectTypeOf<LLMOrchestratorOwner>().toMatchTypeOf<LLMRuntimeCapability>();
    for (const method of [
      'healthCheck',
      'isClosed',
      'callWithinRecovery',
      'streamWithinRecovery',
      'snapshot',
      'probe',
      'getSharedRecoveryDecision',
      'subscribeReady',
      'scheduleProbe',
      'getProviderIdentities',
      'getLegacyProviderIdentities',
    ] as const) {
      expectTypeOf<LLMOrchestratorOwner>().toHaveProperty(method);
    }
  });

  it('Subagent 仅持执行面与共享恢复判据，不持完整 owner', () => {
    type SubagentLLM = SubagentTaskExecutorDeps['llm'];
    expectTypeOf<SubagentLLM>().toMatchTypeOf<LLMOrchestrator>();
    expectTypeOf<SubagentLLM>().toHaveProperty('getSharedRecoveryDecision');
    for (const method of [
      'healthCheck',
      'getFailureDisposition',
      'resetLastSuccessProvider',
      'close',
      'reloadConfig',
      'callWithinRecovery',
      'streamWithinRecovery',
      'snapshot',
      'probe',
    ] as const) {
      expectTypeOf<SubagentLLM>().not.toHaveProperty(method);
    }
  });

  it('call-only 消费方使用 LLMCallCapability，Assembly 保留 owner', () => {
    for (const file of [
      'src/core/summon-system/tools/ask-motion.ts',
      'src/core/memory/system.ts',
      'src/core/memory/deep-dream.ts',
      'src/core/contract/contract-auditor.ts',
    ]) {
      const source = read(file);
      expect(source, file).toContain('LLMCallCapability');
      expect(source, file).not.toMatch(/import type \{ LLMOrchestrator \}/);
    }
    expect(read('src/assembly/core-infrastructure.ts')).toContain('llm: LLMOrchestratorOwner;');
    expect(read('src/foundation/llm-orchestrator/index.ts')).toContain('LLMCallCapability');
  });
});
