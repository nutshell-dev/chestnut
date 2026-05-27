import { describe, it } from 'vitest';
import type { TaskEventHandlerDeps } from '../../src/cli/commands/chat-viewport-task-events';

describe('phase 901 S2 dead deps removed reverse test', () => {
  it('TaskEventHandlerDeps 不应再含 getTaskWatch field（编译期 fail 留痕）', () => {
    // @ts-expect-error — getTaskWatch field 已删、本 type assertion 应 ts compile fail
    const _bad: TaskEventHandlerDeps = {
      getTaskWatch: () => undefined,
      stopTaskWatch: () => {},
      taskStatusBar: {} as any,
    };
    // @ts-expect-error 行命中、test 即 PASS（vitest runtime 不执行 type-only test、仅 tsc check 留痕）
    void _bad;
  });
});
