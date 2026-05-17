/**
 * TOOL_PROFILES DONE_TOOL_NAME 业务语义边界 reverse test (phase 947 M#2 align)
 */
import { describe, it, expect } from 'vitest';
import { TOOL_PROFILES } from '../../../src/foundation/tools/profiles.js';
import {
  DONE_TOOL_NAME,
  SUBMIT_SUBTASK_TOOL_NAME,
} from '../../../src/foundation/tools/tool-names.js';

describe('TOOL_PROFILES DONE_TOOL_NAME 业务语义边界 (phase 947 M#2 align)', () => {
  it('full profile 不含 DONE_TOOL_NAME (main motion 走 submit_subtask 非 done)', () => {
    expect(TOOL_PROFILES.full).not.toContain(DONE_TOOL_NAME);
  });

  it('subagent profile 仍含 DONE_TOOL_NAME (subagent hard-stop 协议)', () => {
    expect(TOOL_PROFILES.subagent).toContain(DONE_TOOL_NAME);
  });

  it('SUBMIT_SUBTASK_TOOL_NAME 在 full profile (main motion 走 contract 流程)', () => {
    expect(TOOL_PROFILES.full).toContain(SUBMIT_SUBTASK_TOOL_NAME);
  });
});
