/**
 * Phase 1950 Step B：EventLoop ↔ LLMOrchestrator 恢复边界 ratchet。
 *
 * 边界事实（Phase 1950 Step A 审计基线 285b3591a）：
 * - provider retry/fallback/breaker/idle 的策略事实唯一归 LLMOrchestrator；
 * - EventLoop 不持有 turn 级 admission controller；每次 LLM invocation 在 owner 内 begin/finish，
 *   EventLoop 只消费 typed 等待与 ready/at/on_change schedule，做 ack/nack 与 facts 转发；
 * - 跨边界输入是 typed LLMRecoveryFacts（干预 ids / 配置修订 / 启动 token），
 *   不是 Record<string, string> 策略通道；
 * - EventLoop 不声明 provider 退避/分类词汇（phase 1268 的 LLMRetryWaitingState /
 *   RecoverableLLMErrorClass 已退役，不得复活）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { LLMOrchestratorOwner } from '../../../src/foundation/llm-orchestrator/index.js';

const EVENT_LOOP_DIR = new URL('../../../src/core/event-loop/', import.meta.url);

function readEventLoopSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of readdirSync(EVENT_LOOP_DIR)) {
    if (!file.endsWith('.ts')) continue;
    sources.set(file, readFileSync(new URL(file, EVENT_LOOP_DIR), 'utf8'));
  }
  return sources;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** provider 策略计算词汇：EventLoop 源码（注释除外）一律不得出现。 */
const PROVIDER_POLICY_TOKENS = [
  'classifyLLMError',
  'LLM_RECOVERY_',
  'retryDelayMs',
  'quotaDelayMs',
  'breaker',
  'LLMErrorClass',
  'RecoverableLLMErrorClass',
  'LLMRetryWaitingState',
  'SharedRecoveryDecision',
  'getSharedRecoveryDecision',
  'scheduleProbe',
];

/** EventLoop 允许从 llm-orchestrator barrel 引入的全部符号。 */
const ALLOWED_ORCHESTRATOR_IMPORTS = new Set([
  'isContextExceededError',
  'LLMRecoveryWaitRequiredError',
  'LLMRecoveryFacts',
  'LLMRecoverySchedule',
  'LLMFailureDisposition',
]);

describe('phase 1950 Step B: event-loop LLM recovery owner boundary', () => {
  it('EventLoop 源码无 provider retry/fallback/breaker/idle 策略计算词汇', () => {
    for (const [file, source] of readEventLoopSources()) {
      const code = stripComments(source);
      for (const token of PROVIDER_POLICY_TOKENS) {
        expect(code, `${file} must not reference provider policy token '${token}'`)
          .not.toContain(token);
      }
    }
  });

  it('EventLoop 不自行构造 recovery schedule（不伪造 kind/resumeAt）', () => {
    for (const [file, source] of readEventLoopSources()) {
      const code = stripComments(source);
      for (const literal of ["kind: 'at'", "kind: 'ready'", "kind: 'on_change'", 'resumeAt:']) {
        expect(code, `${file} must not fabricate schedule literal '${literal}'`)
          .not.toContain(literal);
      }
    }
  });

  it('EventLoop 不含 turn 级 begin/finish 或 activeAttemptId', () => {
    const eventLoop = stripComments(readFileSync(
      new URL('event-loop.ts', EVENT_LOOP_DIR), 'utf8'));
    expect(eventLoop).not.toMatch(/\brecovery\??\.\s*(?:begin|finish)\s*\(/);
    expect(eventLoop).not.toContain('activeAttemptId');
    expect(eventLoop).not.toContain('_admitTurn');
    expect(eventLoop).toContain('LLMRecoveryWaitRequiredError');
  });

  it('EventLoop 从 llm-orchestrator 的 import 收窄为 typed facts 消费面', () => {
    for (const [file, source] of readEventLoopSources()) {
      for (const match of source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[^']*llm-orchestrator\/index\.js'/g,
      )) {
        const names = match[1].split(',').map((n) => n.trim()).filter((n) => n.length > 0);
        for (const name of names) {
          expect(
            ALLOWED_ORCHESTRATOR_IMPORTS.has(name),
            `${file} imports disallowed orchestrator symbol '${name}'`,
          ).toBe(true);
        }
      }
    }
  });

  it('EventLoopOptions 不再暴露 recovery controller；执行恢复仅有只读 schedule 回调', () => {
    const types = stripComments(readFileSync(new URL('types.ts', EVENT_LOOP_DIR), 'utf8'));
    expect(types).not.toContain('LLMRecoveryController');
    expect(types).not.toContain('recovery?: import');
    expect(types).toContain('inspectLlmRecoverySchedule?: () => Promise<LLMRecoverySchedule | undefined>');
  });

  it('公共 owner 仅暴露实例 schedule 查询，invocation 准入与结算留在内部', () => {
    const recoverySrc = readFileSync(
      new URL('../../../src/foundation/llm-orchestrator/recovery.ts', import.meta.url), 'utf8');
    const stateSrc = readFileSync(
      new URL('../../../src/foundation/llm-orchestrator/recovery-state.ts', import.meta.url), 'utf8');

    const owner = recoverySrc.match(
      /export interface LLMOrchestratorOwner extends[^{]+\{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;
    expect(owner).toBeDefined();
    expect(owner).toContain('inspectRecoverySchedule(): Promise<LLMRecoverySchedule>');
    for (const internalControl of ['begin(', 'finish(', 'callWithinRecovery(', 'streamWithinRecovery(']) {
      expect(owner).not.toContain(internalControl);
    }
    expectTypeOf<LLMOrchestratorOwner>().toHaveProperty('inspectRecoverySchedule');
    expectTypeOf<LLMOrchestratorOwner>().not.toHaveProperty('begin');
    expectTypeOf<LLMOrchestratorOwner>().not.toHaveProperty('finish');
    // schedule 判别联合保持 ready/at/on_change 三态（revision 决策链字段不丢）。
    for (const variant of [
      "{ kind: 'ready'; revision: number }",
      "{ kind: 'at'; revision: number; resumeAt: string }",
      "{ kind: 'on_change'; revision: number }",
    ]) {
      expect(stateSrc).toContain(variant);
    }
    const barrel = readFileSync(
      new URL('../../../src/foundation/llm-orchestrator/index.ts', import.meta.url), 'utf8');
    const recoveryExport = barrel.match(
      /export type \{(?<body>[\s\S]*?)\} from '\.\/recovery\.js';/,
    )?.groups?.body;
    expect(recoveryExport).toBeDefined();
    for (const retiredSurface of [
      'LLMRecoveryController', 'LLMRecoveryAdmission', 'LLMRecoverySession',
      'RecoveryCallScope', 'RecoverySessionDeps',
    ]) {
      expect(recoveryExport).not.toContain(retiredSurface);
    }
    expect(barrel).not.toContain('createRecoverySession');
  });
});
