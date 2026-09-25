/**
 * phase 1909 Step B（M13）：onboarding 契约创建/恢复通知正文语义验收。
 *
 * 本测试只锁结构要素，不锁句式标点：
 *  1. 创建态正文含 contractId，指向 onboarding 开始执行
 *  2. 恢复态正文含 contractId 与逐条 pending 子任务列表
 *  3. 两态均不承诺执行结果（只陈述创建/恢复事实与请求）
 */

import { describe, it, expect } from 'vitest';
import {
  onboardingContractCreatedBody,
  onboardingContractResumedBody,
  onboardingLangInstructionTyped,
  onboardingLanguageSubtaskDescription,
  ONBOARDING_LANG_INSTRUCTION_AUTO,
  ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION,
  ONBOARDING_USER_SUBTASK_DESCRIPTION,
  ONBOARDING_SOUL_SUBTASK_DESCRIPTION,
  ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION,
  ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION,
  ONBOARDING_READY_SUBTASK_DESCRIPTION,
} from '../../../src/templates/messages/index.js';

describe('phase 1909: onboarding 契约通知正文（M13）', () => {
  it('创建态：含 contractId 与 onboarding 对象，请求开始执行', () => {
    const body = onboardingContractCreatedBody({ contractId: 'c-abc' });
    expect(body).toContain('c-abc');
    expect(body).toContain('Onboarding');
    expect(body).toMatch(/begin execution/i);
  });

  it('恢复态：含 contractId 与逐条 pending 子任务，请求继续', () => {
    const body = onboardingContractResumedBody({
      contractId: 'c-def',
      pendingSubtasks: ['identity', 'user', 'soul'],
    });
    expect(body).toContain('c-def');
    expect(body).toContain('identity, user, soul');
    expect(body).toMatch(/continue/i);
  });

  it('两态均不承诺执行结果（不冒称已开始/已完成）', () => {
    const created = onboardingContractCreatedBody({ contractId: 'c-1' });
    const resumed = onboardingContractResumedBody({ contractId: 'c-2', pendingSubtasks: [] });
    for (const body of [created, resumed]) {
      expect(body).not.toMatch(/has (started|begun|been completed)/i);
      expect(body).not.toMatch(/已完成|已执行/);
    }
  });
});

describe('phase 1909 Step C: onboarding 子任务描述字面（M13 扩）', () => {
  it('language 子任务：auto/typed 两态语言指示 + 落盘要求', () => {
    expect(ONBOARDING_LANG_INSTRUCTION_AUTO).toContain("user's preferred language");
    const typed = onboardingLangInstructionTyped('你好');
    expect(typed).toContain('你好');
    expect(typed).toMatch(/respond in/);
    const desc = onboardingLanguageSubtaskDescription(ONBOARDING_LANG_INSTRUCTION_AUTO);
    expect(desc).toContain(ONBOARDING_LANG_INSTRUCTION_AUTO);
    expect(desc).toContain('USER.md');
    expect(desc).toContain('not inside clawspace/');
  });

  it('各子任务描述字面齐备且含各自落盘/动作要素', () => {
    expect(ONBOARDING_IDENTITY_SUBTASK_DESCRIPTION).toContain('IDENTITY.md');
    expect(ONBOARDING_USER_SUBTASK_DESCRIPTION).toContain('USER.md');
    expect(ONBOARDING_SOUL_SUBTASK_DESCRIPTION).toContain('SOUL.md');
    expect(ONBOARDING_FIRST_CLAW_SUBTASK_DESCRIPTION).toContain('chestnut claw <name> create');
    expect(ONBOARDING_FIRST_CONTRACT_SUBTASK_DESCRIPTION).toContain('summon');
    expect(ONBOARDING_READY_SUBTASK_DESCRIPTION).toMatch(/complete/i);
  });
});
