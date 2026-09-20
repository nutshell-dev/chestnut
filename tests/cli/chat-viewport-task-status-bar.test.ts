import { describe, it, expect, vi } from 'vitest';
import { createTaskStatusBar, buildTaskLine, makeTaskTrack } from '../../src/viewport/chat-viewport-task-status-bar.js';

describe('chat-viewport-task-status-bar', () => {
  const makeDeps = () => {
    const updateRender = vi.fn();
    return { updateRender, bar: createTaskStatusBar({ updateRender }) };
  };

  it('addTrack(subagent) goes to spawn, not shadow', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-abc', 'spawn_subagent');
    const spawn = bar.renderSpawn(80);
    const shadow = bar.renderShadow(80);
    // prefix 'spawn-' + slice(0,6) 'task-a' → 'spawn-task-a'
    expect(spawn).toContain('spawn-task-a');
    expect(shadow).not.toContain('spawn-task-a');
  });

  it('addTrack(shadow) goes to shadow, not spawn', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-def', 'shadow_subagent');
    const spawn = bar.renderSpawn(80);
    const shadow = bar.renderShadow(80);
    // prefix 'shadow-' + slice(0,6) 'task-d' → 'shadow-task-d'
    expect(shadow).toContain('shadow-task-d');
    expect(spawn).not.toContain('shadow-task-d');
  });

  it('unshift order: newest at head (visual top)', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-a', 'spawn_subagent');
    bar.addTrack('task-b', 'spawn_subagent');
    bar.addTrack('task-c', 'spawn_subagent');
    const spawn = bar.renderSpawn(80);
    const lines = spawn.split('\n');
    // head = newest = task-c → label 'spawn-task-c'
    expect(lines[0]).toContain('spawn-task-c');
    expect(lines[1]).toContain('spawn-task-b');
    expect(lines[2]).toContain('spawn-task-a');
  });

  it('updateTrack tool_call renders tool name', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-x', 'spawn_subagent');
    bar.updateTrack('task-x', { type: 'tool_call', name: 'exec' });
    const spawn = bar.renderSpawn(80);
    expect(spawn).toContain('exec');
  });

  it('updateTrack text_delta renders buffered text', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-y', 'spawn_subagent');
    bar.updateTrack('task-y', { type: 'text_delta', delta: 'hello' });
    const spawn = bar.renderSpawn(80);
    expect(spawn).toContain('hello');
  });

  it('updateTrack turn_end removes track immediately', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-z', 'spawn_subagent');
    expect(bar.renderSpawn(80)).toContain('spawn-task-z');
    bar.updateTrack('task-z', { type: 'turn_end' });
    expect(bar.renderSpawn(80)).not.toContain('spawn-task-z');
    expect(bar.renderShadow(80)).not.toContain('spawn-task-z');
  });

  it('taskKind=spawn maps to spawn tracks', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-spawn', 'spawn');
    // 'spawn' != 'shadow' → maps to 'subagent' → prefix 'spawn-'
    // slice(0,6): 'task-s' + prefix 'spawn-' → 'spawn-task-s'
    expect(bar.renderSpawn(80)).toContain('spawn-task-s');
    expect(bar.renderShadow(80)).not.toContain('spawn-task-s');
  });

  it('hasAny reflects track presence', () => {
    const { bar } = makeDeps();
    expect(bar.hasAny()).toBe(false);
    bar.addTrack('task-1', 'spawn_subagent');
    expect(bar.hasAny()).toBe(true);
    bar.removeTrack('task-1');
    expect(bar.hasAny()).toBe(false);
  });

  // phase 1401 Bug C: stale-sweep / shutdown 路径 stopTaskWatch 必同步清 UI track，
  // 否则 shadowTracks 残留渲染 `[shadow-xxxxxx] ⊙ ()` 永不清。
  // 直接验 removeTrack idempotent 行为 + 即使没经 turn_end 也能清干净。
  it('removeTrack on shadow track without prior turn_end (stale-sweep path)', () => {
    const { bar, updateRender } = makeDeps();
    bar.addTrack('shadow-stale', 'shadow_subagent');
    expect(bar.renderShadow(80)).toContain('shadow-shadow');
    expect(bar.hasAny()).toBe(true);
    const renderCallsBefore = updateRender.mock.calls.length;
    bar.removeTrack('shadow-stale');
    expect(bar.renderShadow(80)).not.toContain('shadow-shadow');
    expect(bar.hasAny()).toBe(false);
    expect(updateRender.mock.calls.length).toBeGreaterThan(renderCallsBefore);
  });

  it('removeTrack is idempotent (turn_end then stale-sweep double-call safe)', () => {
    const { bar, updateRender } = makeDeps();
    bar.addTrack('task-dup', 'spawn_subagent');
    bar.updateTrack('task-dup', { type: 'turn_end' });
    expect(bar.hasAny()).toBe(false);
    const callsAfterFirstRemove = updateRender.mock.calls.length;
    // second removeTrack（stopTaskWatch path）应 noop / 不报错
    expect(() => bar.removeTrack('task-dup')).not.toThrow();
    expect(bar.hasAny()).toBe(false);
    // 第二次 noop 不触发 updateRender
    expect(updateRender.mock.calls.length).toBe(callsAfterFirstRemove);
  });

  // Phase 833: migrated exec task rendering
  it('addMigratedExec renders exec indicator with command', () => {
    const { bar } = makeDeps();
    bar.addMigratedExec({ taskId: 'exec-1', command: 'sleep 10', startedAt: Date.now() - 2 * 60_000 });
    const rendered = bar.renderMigratedExec(80);
    expect(rendered).toContain('⚙ exec 2m');
    expect(rendered).toContain(' · sleep 10');
    expect(rendered).toContain('sleep 10');
  });

  it('addMigratedExec shows 0m for recent tasks', () => {
    const { bar } = makeDeps();
    bar.addMigratedExec({ taskId: 'exec-2', command: 'sleep 1', startedAt: Date.now() - 10_000 });
    const rendered = bar.renderMigratedExec(80);
    expect(rendered).toContain('⚙ exec 0m');
    expect(rendered).toContain(' · sleep 1');
  });

  it('removeMigratedExec removes the indicator', () => {
    const { bar } = makeDeps();
    bar.addMigratedExec({ taskId: 'exec-3', command: 'sleep 5', startedAt: Date.now() });
    expect(bar.renderMigratedExec(80)).toContain('sleep 5');
    bar.removeMigratedExec('exec-3');
    expect(bar.renderMigratedExec(80)).toBe('');
  });

  it('hasAny includes migrated exec tracks', () => {
    const { bar } = makeDeps();
    expect(bar.hasAny()).toBe(false);
    bar.addMigratedExec({ taskId: 'exec-4', command: 'sleep 5', startedAt: Date.now() });
    expect(bar.hasAny()).toBe(true);
  });

  it('migrated exec tracks are independent from spawn/shadow tracks', () => {
    const { bar } = makeDeps();
    bar.addMigratedExec({ taskId: 'exec-5', command: 'sleep 5', startedAt: Date.now() });
    expect(bar.renderSpawn(80)).toBe('');
    expect(bar.renderShadow(80)).toBe('');
    expect(bar.renderMigratedExec(80)).not.toBe('');
  });

  it('migrated exec command longer than 80 chars is not rendered fully by the bar', () => {
    const { bar } = makeDeps();
    const longCommand = 'a'.repeat(120);
    bar.addMigratedExec({ taskId: 'exec-6', command: longCommand, startedAt: Date.now() });
    const rendered = bar.renderMigratedExec(80);
    expect(rendered.length).toBeLessThanOrEqual(longCommand.length + 30);
    expect(rendered).toContain('⚙ exec');
    expect(rendered).toContain(' · ');
  });
});

describe('buildTaskLine', () => {
  it('renders tool call with buffered thinking', () => {
    const t = makeTaskTrack('abc12345', 'spawn_subagent');
    t.currentTool = 'read_file';
    t.textBuffer = 'pondering';
    t.bufferType = 'thinking';
    const line = buildTaskLine(t, 80);
    // 'spawn_subagent' → prefix 'spawn-' + slice(0,6) 'abc123' → '[spawn-abc123]'
    expect(line).toContain('[spawn-abc123]');
    expect(line).toContain('read_file');
    expect(line).toContain('(pondering)');
  });

  it('renders idle track with text buffer', () => {
    const t = makeTaskTrack('def67890', 'shadow_subagent');
    t.textBuffer = 'some output';
    t.bufferType = 'text';
    const line = buildTaskLine(t, 80);
    // 'shadow_subagent' → prefix 'shadow-' + slice(0,6) 'def678' → '[shadow-def678]'
    expect(line).toContain('[shadow-def678]');
    expect(line).toContain('some output');
  });
});

/**
 * Phase 1268 Step D: task 流 llm_retry_waiting → 状态行 waitingLabel（带 taskId label）
 */
describe('Phase 1268 Step D: task llm_retry_waiting status bar', () => {
  const makeDeps = () => {
    const updateRender = vi.fn();
    return { updateRender, bar: createTaskStatusBar({ updateRender }) };
  };

  it('retry waiting 显示 retry attempt/max 与等待，行首含 taskId label', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-w1', 'spawn_subagent');
    bar.updateTrack('task-w1', {
      type: 'llm_retry_waiting', stage: 'retry', action: 'scheduled',
      attempt: 2, maxAttempts: 3, delayMs: 60_000,
      resumeAt: '2026-08-02T13:15:12.000Z', errorClass: 'rate_limit',
    });
    const spawn = bar.renderSpawn(80);
    expect(spawn).toContain('spawn-task-w');
    expect(spawn).toContain('retry 2/3 in 60s');
  });

  it('cooldown waiting 显示 probe deadline（结构断言，不依赖时区）', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-w2', 'spawn_subagent');
    bar.updateTrack('task-w2', {
      type: 'llm_retry_waiting', stage: 'cooldown', action: 'scheduled',
      attempt: 3, maxAttempts: 3, delayMs: 300_000,
      resumeAt: '2026-08-02T13:15:12.000Z', errorClass: 'rate_limit',
    });
    const spawn = bar.renderSpawn(80);
    expect(spawn).toContain('cooldown, probe at');
    expect(spawn).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('released 清空 waitingLabel', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-w3', 'spawn_subagent');
    bar.updateTrack('task-w3', {
      type: 'llm_retry_waiting', stage: 'retry', action: 'scheduled',
      attempt: 1, maxAttempts: 3, delayMs: 30_000,
      resumeAt: '2026-08-02T13:15:12.000Z', errorClass: 'transient',
    });
    expect(bar.renderSpawn(80)).toContain('retry 1/3');
    bar.updateTrack('task-w3', {
      type: 'llm_retry_waiting', stage: 'retry', action: 'released',
      attempt: 1, maxAttempts: 3, delayMs: 0,
      resumeAt: '2026-08-02T13:15:12.000Z', errorClass: 'transient',
    });
    expect(bar.renderSpawn(80)).not.toContain('retry 1/3');
  });
});

/**
 * Phase 1826: task 流 recovery_scheduled → 状态行等待摘要（owner 恢复安排）
 */
describe('Phase 1826: task recovery_scheduled status bar', () => {
  const makeDeps = () => {
    const updateRender = vi.fn();
    return { updateRender, bar: createTaskStatusBar({ updateRender }) };
  };

  it('at 安排显示分类与恢复时刻；on_change 显示等待干预；ready 清空', () => {
    const { bar } = makeDeps();
    bar.addTrack('task-r1', 'spawn_subagent');
    bar.updateTrack('task-r1', {
      type: 'recovery_scheduled', scope: 'foreground', revision: 2, scheduleKind: 'at',
      resumeAt: '2026-08-02T13:15:12.000Z', errorClass: 'quota', providerCount: 1, failureCount: 1,
    });
    expect(bar.renderSpawn(80)).toContain('quota recovery at');
    expect(bar.renderSpawn(80)).toMatch(/\d{2}:\d{2}:\d{2}/);

    bar.updateTrack('task-r1', {
      type: 'recovery_scheduled', scope: 'foreground', revision: 3, scheduleKind: 'on_change',
      resumeAt: '', errorClass: 'permanent', providerCount: 1, failureCount: 2,
    });
    expect(bar.renderSpawn(80)).toContain('config change needed; waiting for intervention');

    bar.updateTrack('task-r1', { type: 'recovery_ready', scope: 'foreground', revision: 4, reason: 'success' });
    expect(bar.renderSpawn(80)).not.toContain('recovery at');
    expect(bar.renderSpawn(80)).not.toContain('waiting for intervention');
  });
});
