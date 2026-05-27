import { describe, it, expect } from 'vitest';
import { createTaskStatusBar } from '../../src/cli/commands/chat-viewport-task-status-bar.js';

describe('phase 940 r117 B fork — empty tool name silent fall-through fix', () => {
  it('tool_call without name → currentTool null (no tool active)', () => {
    const bar = createTaskStatusBar({ updateRender: () => {} });
    bar.addTrack('task-1', 'subagent');
    bar.updateTrack('task-1', { type: 'tool_call' }); // 无 name field
    const line = bar.renderSpawn(80);
    // null currentTool → 走 ⊙ ghost branch + 不显 tool name
    expect(line).toContain('⊙');
    expect(line).not.toContain('⚙');
  });

  it('tool_call with empty string name → currentTool null', () => {
    const bar = createTaskStatusBar({ updateRender: () => {} });
    bar.addTrack('task-1', 'subagent');
    bar.updateTrack('task-1', { type: 'tool_call', name: '' });
    const line = bar.renderSpawn(80);
    expect(line).toContain('⊙'); // 空串视为无 tool
    expect(line).not.toContain('⚙');
  });

  it('tool_call with valid name → currentTool string + ⚙ branch', () => {
    const bar = createTaskStatusBar({ updateRender: () => {} });
    bar.addTrack('task-1', 'subagent');
    bar.updateTrack('task-1', { type: 'tool_call', name: 'read' });
    const line = bar.renderSpawn(80);
    expect(line).toContain('⚙');
    expect(line).toContain('read');
  });
});
