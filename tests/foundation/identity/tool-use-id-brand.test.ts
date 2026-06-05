import { describe, it, expect } from 'vitest';
import type { ToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import { makeToolUseId } from '../../../src/foundation/tool-protocol/index.js';
import type { TaskId } from '../../../src/core/async-task-system/types.js';
import { makeTaskId } from '../../../src/core/async-task-system/types.js';

describe('ToolUseId brand compile-time enforce', () => {
  it('prevents assigning TaskId to ToolUseId', () => {
    function processToolUse(_t: ToolUseId): string {
      return 'ok';
    }
    const taskId: TaskId = makeTaskId('task-1');
    // @ts-expect-error TS2345: TaskId cannot be assigned to ToolUseId
    processToolUse(taskId);
    expect(true).toBe(true);
  });

  it('prevents raw string literal assignment to ToolUseId', () => {
    // @ts-expect-error TS2322: raw string cannot be assigned to ToolUseId
    const t: ToolUseId = 'raw-tool-use';
    expect(t).toBeDefined();
  });

  it('allows properly constructed ToolUseId', () => {
    function processToolUse(_t: ToolUseId): string {
      return 'ok';
    }
    const t = makeToolUseId('valid-tool-use');
    expect(processToolUse(t)).toBe('ok');
  });
});
