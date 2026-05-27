import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('phase 1184 loadStableTurnBoundary', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  const filename = 'current.json';
  const clawId = 'test-claw';

  beforeEach(async () => {
    tempDir = await createTempDir('clawforum-test-');
    fs = new NodeFileSystem({ baseDir: tempDir });
  });
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ─── 主路径 ─────────────────────────────────────────────────────────
  it('已 paired snapshot 0 truncate 行为差', async () => {
    const { audit, events } = makeAudit();
    const store = new DialogStore(fs, '', audit, filename, clawId);
    await store.save({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'foo', input: {} },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        ]},
      ],
      toolsForLLM: [],
    });
    const { session } = await store.loadStableTurnBoundary();
    expect(session.messages.length).toBe(3);  // 0 truncate
    expect(events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_BOUNDARY_TRUNCATED).length).toBe(0);
  });

  // ─── 反向 3 项 ───────────────────────────────────────────────────────
  it('反向 1：末条 unpaired tool_use → 截断 + emit TURN_BOUNDARY_TRUNCATED', async () => {
    const { audit, events } = makeAudit();
    const store = new DialogStore(fs, '', audit, filename, clawId);
    await store.save({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_1', name: 'foo', input: {} },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        ]},
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_2', name: 'bar', input: {} },  // unpaired
        ]},
      ],
      toolsForLLM: [],
    });
    const { session } = await store.loadStableTurnBoundary();
    expect(session.messages.length).toBe(3);  // last assistant truncated
    const evt = events.find(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_BOUNDARY_TRUNCATED);
    expect(evt).toBeDefined();
    expect(evt!).toContain('truncated_count=1');
    expect(evt!).toContain('unpaired_tool_use_id=tu_2');
  });

  it('反向 2：mid-message unpaired tool_use → 截断 + emit', async () => {
    const { audit, events } = makeAudit();
    const store = new DialogStore(fs, '', audit, filename, clawId);
    await store.save({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_unpaired', name: 'foo', input: {} },
        ]},
        // No tool_result follow-up — Motion would save here mid-turn between LLM call and tool exec
      ],
      toolsForLLM: [],
    });
    const { session } = await store.loadStableTurnBoundary();
    expect(session.messages.length).toBe(1);  // truncate to before unpaired tool_use
    const evt = events.find(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_BOUNDARY_TRUNCATED);
    expect(evt).toBeDefined();
  });

  it('反向 3：所有 tool_use 已配对 (mixed paired/text) → 0 truncate', async () => {
    const { audit, events } = makeAudit();
    const store = new DialogStore(fs, '', audit, filename, clawId);
    await store.save({
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'tu_a', name: 'foo', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'bar', input: {} },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_a', content: 'a-ok' },
          { type: 'tool_result', tool_use_id: 'tu_b', content: 'b-ok' },
        ]},
        { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
      ],
      toolsForLLM: [],
    });
    const { session } = await store.loadStableTurnBoundary();
    expect(session.messages.length).toBe(4);  // 0 truncate
    expect(events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.TURN_BOUNDARY_TRUNCATED).length).toBe(0);
  });
});
