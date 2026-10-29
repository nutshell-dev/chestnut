import { describe, expect, it } from 'vitest';
import {
  createLauncherUiSemantics,
  isUiActionEnabled,
  renderTerminalAction,
  renderTerminalActivity,
} from '../../src/cli-protocol/index.js';
import { buildTaskLine, makeTaskTrack } from '../../src/viewport/chat-viewport-task-status-bar.js';

const semantics = createLauncherUiSemantics();
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

describe('viewport shared UI semantics', () => {
  it('uses shared action labels and constraints without changing terminal key ownership', () => {
    expect(renderTerminalAction(semantics.actions['chat.send'])).toBe('发送');
    expect(isUiActionEnabled(semantics.actions['chat.send'], { 'composer.nonempty': false })).toBe(false);
    expect(isUiActionEnabled(semantics.actions['chat.send'], { 'composer.nonempty': true })).toBe(true);
    expect(isUiActionEnabled(semantics.actions['chat.interrupt'], { 'turn.active': false })).toBe(false);
    expect(isUiActionEnabled(semantics.actions['chat.interrupt'], { 'turn.active': true })).toBe(true);
  });

  it('maps the same activity states and safe details as the native projection', () => {
    expect(renderTerminalActivity(semantics, { phase: 'idle' })).toBeNull();
    expect(renderTerminalActivity(semantics, { phase: 'waiting' })).toBe('Thinking…');
    expect(renderTerminalActivity(semantics, { phase: 'responding' })).toBe('Streaming…');
    expect(renderTerminalActivity(semantics, { phase: 'processing', label: 'thinking', detail: 'plan' })).toBe('(plan)');
    expect(renderTerminalActivity(semantics, { phase: 'processing', label: 'text', detail: 'draft' })).toBe('"draft"');
    expect(renderTerminalActivity(semantics, { phase: 'processing', label: 'tool', detail: 'search' })).toBe('search');
    expect(renderTerminalActivity(semantics, { phase: 'error', detail: '[motion] ✗ failed' })).toBe('[motion] ✗ failed');
    expect(renderTerminalActivity(semantics, { phase: 'retry' })).toBe('retrying');
  });

  it('keeps task line layout while sourcing summary punctuation from shared semantics', () => {
    const track = makeTaskTrack('task-ui', 'spawn_subagent');
    track.currentTool = 'search';
    track.bufferType = 'text';
    track.textBuffer = 'draft';
    expect(plain(buildTaskLine(track, 120))).toBe('[spawn-task-u] ⚙ search · "draft"');
    track.bufferType = 'thinking';
    track.textBuffer = 'plan';
    expect(plain(buildTaskLine(track, 120))).toBe('[spawn-task-u] ⚙ search · (plan)');
  });
});
