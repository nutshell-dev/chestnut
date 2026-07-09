import { describe, it, expect, vi } from 'vitest';
import { createTaskStatusBar, buildTaskLine, makeTaskTrack } from '../../src/cli/commands/chat-viewport-task-status-bar.js';

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

  it('callerType=spawn maps to spawn tracks', () => {
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
