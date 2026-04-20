import { describe, it, expect } from 'vitest';
import type { MainTurnUIController, TaskEventHandlerDeps } from '../../src/cli/commands/chat-viewport.js';

describe('chat-viewport 编译期契约', () => {
  it('TaskEventHandlerDeps 不应包含 mainUI 字段（@ts-expect-error 验证）', () => {
    // @ts-expect-error 消费该行应当产生的类型错误（mainUI 不在 TaskEventHandlerDeps 字段集内）。
    // 如果未来有人给 TaskEventHandlerDeps 加了 mainUI 字段，该行不再报类型错 →
    // tsc 反向报 "Unused '@ts-expect-error' directive" → 测试构建失败。
    const badDeps: TaskEventHandlerDeps = {
      getTaskWatch: () => undefined,
      showRecapStream: () => false,
      appendOutput: () => {},
      stopTaskWatch: () => {},
      mainUI: {} as MainTurnUIController,
    };

    // 防止 unused variable
    expect(badDeps).toBeDefined();
  });
});
