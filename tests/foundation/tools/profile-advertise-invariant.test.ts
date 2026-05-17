/**
 * Phase 963 r119 B fork — Profile advertise invariant lint test
 *
 * Invariant: ∀ name ∈ ToolName union ⇒ ∃ profile ∈ TOOL_PROFILES, name ∈ profile.
 *
 * Catches NEW 工具加 register 但漏 profile DOA 反模式 (phase 894 NEW.P0.1 N=1 first occurrence
 * - notify_claw register without full profile entry → motion LLM unable to see tool).
 *
 * Scope: ToolName union members only (`_TOOL_NAME` const at `tool-names.ts`).
 * Excludes: ASK_USER_TOOL_NAME (gateway/ask-user-tool.ts:13 string literal,
 * outside ToolName union, goes via gateway 旁路 surface not LLM advertise pipeline).
 *
 * Mirror: `readonly-supports-async-mutex.test.ts` lint-as-test 模板 (phase 614 N=5+).
 */
import { describe, it, expect } from 'vitest';
import * as toolNames from '../../../src/foundation/tools/tool-names.js';
import { TOOL_PROFILES } from '../../../src/foundation/tools/profiles.js';

describe('phase 963 — profile advertise invariant lint', () => {
  // 反射所有 `*_TOOL_NAME` const exports
  const allToolNames = Object.entries(toolNames)
    .filter(([key, value]) => key.endsWith('_TOOL_NAME') && typeof value === 'string')
    .map(([, value]) => value as string);

  // 平铺所有 profile 中的 tool name
  const profileNames = new Set<string>(
    Object.values(TOOL_PROFILES).flatMap((arr) => arr as readonly string[]),
  );

  it('every ToolName const has at least one profile entry', () => {
    const missing = allToolNames.filter((name) => !profileNames.has(name));
    expect(missing).toEqual([]);
  });

  // 反向 1（误删反向）：sanity-check export 数量 ≥ 19、防 tool-names.ts export 漏
  it('tool-names.ts exports ≥ 19 `*_TOOL_NAME` const (catches export omission regression)', () => {
    expect(allToolNames.length).toBeGreaterThanOrEqual(19);
  });

  // 反向 2（schema 反向）：ask_user 不应在 ToolName union (gateway 旁路 surface)、test reflect 当前 scope split
  it('ask_user is NOT in ToolName scope (gateway 旁路 surface, phase 894 sharpen)', () => {
    expect(allToolNames).not.toContain('ask_user');
  });
});
