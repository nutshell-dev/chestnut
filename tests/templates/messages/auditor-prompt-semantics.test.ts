/**
 * phase 1909 Step C（M18）：契约审计子代理系统提示词语义验收。
 *
 * 整段英文提示词机械迁移，按风险表要求做**逐字节断言**（防顺手润色）；
 * 另锁语义要素：审计角色、输入（近期活动 vs 契约期望）、输出契约
 * （on_track 或具体 drift、strict JSON only）。
 */

import { describe, it, expect } from 'vitest';
import { AUDITOR_SYSTEM_PROMPT } from '../../../src/templates/messages/index.js';

/** 迁移前 contract-auditor.ts:106 的逐字节字面（expected 为 literal，不经模板生成）。 */
const EXPECTED_PROMPT = `You are a contract auditor for an autonomous AI agent. Read recent activity, compare to contract expectations, and report either "on_track" or specific drifts. Output strict JSON only.`;

describe('phase 1909: 契约审计系统提示词（M18）', () => {
  it('逐字节同迁移前字面', () => {
    expect(AUDITOR_SYSTEM_PROMPT).toBe(EXPECTED_PROMPT);
  });

  it('语义要素齐备：角色 / 输入 / 输出契约', () => {
    expect(AUDITOR_SYSTEM_PROMPT).toContain('contract auditor');
    expect(AUDITOR_SYSTEM_PROMPT).toContain('recent activity');
    expect(AUDITOR_SYSTEM_PROMPT).toContain('contract expectations');
    expect(AUDITOR_SYSTEM_PROMPT).toContain('on_track');
    expect(AUDITOR_SYSTEM_PROMPT).toContain('drifts');
    expect(AUDITOR_SYSTEM_PROMPT).toContain('strict JSON only');
  });
});
