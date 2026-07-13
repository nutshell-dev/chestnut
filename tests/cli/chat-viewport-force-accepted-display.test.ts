/**
 * @module tests/cli/chat-viewport-force-accepted-display
 * Phase 1405 Fix 4: viewport handler 区分 force-accepted vs 真通过
 *
 * Phase 1399 加 force_accepted event 字段、但 viewport handler 不读 → 用户在 chat 看到的
 * `✓ subtask passed` 与真通过完全一样、失去质量信号。本测试核 handler 读 force_accepted
 * 字段并显示 ⚠ 前缀.
 */

import { describe, it, expect, vi } from 'vitest';
import { createEventHandler, type EventHandlerDeps } from '../../src/cli/commands/chat-viewport-event-handler.js';

function makeDeps(captured: { lines: string[] }): EventHandlerDeps {
  return {
    turnTracker: { begin: vi.fn(), end: vi.fn() } as any,
    mainUI: {
      flushThinking: vi.fn(),
      flushStreaming: vi.fn(),
      enterPhase: vi.fn(),
      clearPreview: vi.fn(),
    } as any,
    sink: { emit: (d: any) => { if (d.kind === 'text-line') captured.lines.push(d.text); } },
    showSystemMessages: false,
    showContractEvents: true,
    agentDir: '/tmp/agent',
    label: 'self-claw',
    audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
    observability: { recordEvent: vi.fn() } as any,
    taskWatchMap: new Map(),
    handleTaskEvent: vi.fn(),
    taskStatusBar: { addTrack: vi.fn() },
    getThinkingMode: () => 'auto',
    fsFactory: vi.fn() as any,
  };
}

describe('phase 1405 Fix 4: viewport 区分 force-accepted', () => {
  it('subtask_completed + force_accepted=true → 显示 ⚠ force-accepted', () => {
    const captured = { lines: [] as string[] };
    const handler = createEventHandler(makeDeps(captured));

    handler({
      type: 'user_notify',
      subtype: 'subtask_completed',
      subtaskId: 'st1',
      clawId: 'other-claw',
      completedCount: 2,
      subtaskTotal: 3,
      force_accepted: true,
    });

    expect(captured.lines.length).toBe(1);
    expect(captured.lines[0]).toContain('⚠');
    expect(captured.lines[0]).toContain('force-accepted');
    expect(captured.lines[0]).toContain('st1');
    expect(captured.lines[0]).toContain('other-claw');
    expect(captured.lines[0]).not.toContain('passed');
  });

  it('subtask_completed without force_accepted → 显示 ✓ passed（既有行为不破）', () => {
    const captured = { lines: [] as string[] };
    const handler = createEventHandler(makeDeps(captured));

    handler({
      type: 'user_notify',
      subtype: 'subtask_completed',
      subtaskId: 'st1',
      clawId: 'other-claw',
      completedCount: 1,
      subtaskTotal: 3,
    });

    expect(captured.lines.length).toBe(1);
    expect(captured.lines[0]).toContain('✓');
    expect(captured.lines[0]).toContain('passed');
    expect(captured.lines[0]).not.toContain('force-accepted');
    expect(captured.lines[0]).not.toContain('⚠');
  });

  it('reverse: 自己的契约通知仍被过滤（label === clawId）', () => {
    const captured = { lines: [] as string[] };
    const handler = createEventHandler(makeDeps(captured));

    handler({
      type: 'user_notify',
      subtype: 'subtask_completed',
      subtaskId: 'st1',
      clawId: 'self-claw',  // == deps.label
      force_accepted: true,
    });

    expect(captured.lines.length).toBe(0);
  });
});
