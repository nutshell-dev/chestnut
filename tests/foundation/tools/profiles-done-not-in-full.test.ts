/**
 * Tool profiles business semantic boundary test (phase 947 M#2 align)
 */
import { describe, it, expect } from 'vitest';
import { createDoneTool } from '../../../src/core/subagent/tools/done.js';
import { createSubmitSubtaskTool } from '../../../src/core/contract/tools/submit-subtask.js';

describe('Tool profiles DONE_TOOL_NAME business semantic boundary (phase 947 M#2 align)', () => {
  it('full profile does not contain DONE_TOOL_NAME (main motion uses submit_subtask not done)', () => {
    const doneTool = createDoneTool();
    expect(doneTool.profiles).not.toContain('full');
  });

  it('subagent profile still contains DONE_TOOL_NAME (subagent hard-stop protocol)', () => {
    const doneTool = createDoneTool();
    expect(doneTool.profiles).toContain('subagent');
  });

  it('SUBMIT_SUBTASK_TOOL_NAME is in full profile (main motion uses contract flow)', () => {
    const submitSubtaskTool = createSubmitSubtaskTool({} as any);
    expect(submitSubtaskTool.profiles).toContain('full');
  });
});
