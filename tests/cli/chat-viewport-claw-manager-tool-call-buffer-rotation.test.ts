/**
 * Phase 1429: chat-viewport-claw-manager tool_call buffer rotation
 *
 * 反向核：
 *   1. 首轮 tool_call（toolSuccess 仍 null）保留前序 thinking buffer 显示执行上下文
 *   2. 续轮 tool_call（上一 tool 已 result、toolSuccess !== null）立即清旧 buffer 防 stale 跨多 round 滞留
 *   3. 续轮清后下一 thinking_delta 来正常累入新 buffer
 *   4. turn_end 后 turn_start 重启 → 新 turn 首轮 tool_call 仍走"保留"路径（toolSuccess 已被 turn_end 重置 null）
 */
import { describe, it, expect, vi } from 'vitest';
import { createClawManager } from '../../src/cli/commands/chat-viewport-claw-manager.js';
import { makeClawTrack, type ClawTrack } from '../../src/cli/commands/chat-viewport-claw-line.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type { ClawTopology } from '../../src/core/claw-topology/index.js';

// isAlive not mocked — createClawManager tests use readPid=null path so isAlive is never called (phase 106 DI hygiene)

function makeMockTopology(clawsDir: string): ClawTopology {
  return {
    enumerate: vi.fn().mockReturnValue([]),
    resolve: vi.fn((clawId: string) => ({ kind: 'local', clawDir: `${clawsDir}/${clawId}` })),
    read: vi.fn(),
    readJSON: vi.fn(),
  } as unknown as ClawTopology;
}

function makeStreamFs(content: string): FileSystem {
  const buf = Buffer.from(content, 'utf-8');
  return {
    readSync: vi.fn(),
    read: vi.fn(),
    writeAtomic: vi.fn(),
    writeAtomicSync: vi.fn(),
    append: vi.fn(),
    appendSync: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    list: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readBytesSync: vi.fn().mockReturnValue(buf),
    statSync: vi.fn().mockReturnValue({ size: buf.length }),
    listSync: vi.fn().mockReturnValue([]),
  } as unknown as FileSystem;
}

function driveStream(clawId: string, streamJsonl: string): ClawTrack {
  const track = makeClawTrack();
  const clawTrackMap = new Map<string, ClawTrack>([[clawId, track]]);
  const fs = makeStreamFs(streamJsonl);

  const manager = createClawManager({
    fs,
    pm: { readPid: vi.fn().mockResolvedValue(null) },
    audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as unknown as AuditLog,
    isMotion: true,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/claws',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawTopology: makeMockTopology('/tmp/claws'),
    clawTrackMap,
    updateClawPanel: vi.fn(),
    requestRender: vi.fn(),
  });
  manager.refreshClawStatus(clawId);
  return track;
}

const J = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe('chat-viewport-claw-manager tool_call buffer rotation (phase 1429)', () => {
  it('case 1: first tool_call within turn retains prior thinking buffer', () => {
    const stream = [
      J({ type: 'turn_start' }),
      J({ type: 'thinking_delta', delta: 'Let me search the AuditLog module.' }),
      J({ type: 'tool_call', name: 'exec' }),
    ].join('\n') + '\n';

    const track = driveStream('claw-a', stream);

    expect(track.currentTool).toBe('exec');
    expect(track.toolSuccess).toBeNull();
    expect(track.textBuffer).toBe('Let me search the AuditLog module.');
    expect(track.bufferType).toBe('thinking');
    expect(track.clearOnNextDelta).toBe(true);
  });

  it('case 2: second tool_call after tool_result clears stale buffer immediately', () => {
    const stream = [
      J({ type: 'turn_start' }),
      J({ type: 'thinking_delta', delta: 'The AuditLog module code is not in workspace.' }),
      J({ type: 'tool_call', name: 'exec' }),
      J({ type: 'tool_result', success: true }),
      J({ type: 'tool_call', name: 'exec' }),
    ].join('\n') + '\n';

    const track = driveStream('claw-b', stream);

    expect(track.currentTool).toBe('exec');
    expect(track.toolSuccess).toBeNull();
    expect(track.textBuffer).toBe('');
    expect(track.bufferType).toBeNull();
    expect(track.clearOnNextDelta).toBe(false);
  });

  it('case 3: thinking_delta after second tool_call writes fresh buffer (not appended to stale)', () => {
    const stream = [
      J({ type: 'turn_start' }),
      J({ type: 'thinking_delta', delta: 'old thinking from round 1' }),
      J({ type: 'tool_call', name: 'exec' }),
      J({ type: 'tool_result', success: true }),
      J({ type: 'tool_call', name: 'read' }),
      J({ type: 'thinking_delta', delta: 'new thinking for round 2' }),
    ].join('\n') + '\n';

    const track = driveStream('claw-c', stream);

    expect(track.textBuffer).toBe('new thinking for round 2');
    expect(track.bufferType).toBe('thinking');
    expect(track.currentTool).toBe('read');
  });

  it('case 4: many consecutive tool rounds keep buffer empty (no stale accumulation)', () => {
    const lines = [J({ type: 'turn_start' }), J({ type: 'thinking_delta', delta: 'initial thought' })];
    for (let i = 0; i < 20; i++) {
      lines.push(J({ type: 'tool_call', name: 'exec' }));
      lines.push(J({ type: 'tool_result', success: true }));
    }
    const stream = lines.join('\n') + '\n';

    const track = driveStream('claw-d', stream);

    // 序列结尾是 tool_result（toolSuccess 已 set），上一个 tool_call (round 20) 已清 buffer
    expect(track.textBuffer).toBe('');
    expect(track.bufferType).toBeNull();
    expect(track.toolSuccess).toBe(true);
  });

  it('case 5: turn_end resets toolSuccess so next turn first tool_call retains again', () => {
    const stream = [
      J({ type: 'turn_start' }),
      J({ type: 'thinking_delta', delta: 'round-1 thinking' }),
      J({ type: 'tool_call', name: 'exec' }),
      J({ type: 'tool_result', success: true }),
      J({ type: 'turn_end' }),
      J({ type: 'turn_start' }),
      J({ type: 'thinking_delta', delta: 'round-2 fresh thinking' }),
      J({ type: 'tool_call', name: 'exec' }),
    ].join('\n') + '\n';

    const track = driveStream('claw-e', stream);

    // 第二轮 turn 的首次 tool_call、toolSuccess 已被 turn_end 重置 null → 保留路径
    expect(track.textBuffer).toBe('round-2 fresh thinking');
    expect(track.bufferType).toBe('thinking');
    expect(track.clearOnNextDelta).toBe(true);
    expect(track.currentTool).toBe('exec');
    expect(track.toolSuccess).toBeNull();
  });

  it('case 6: second tool_call after text_delta between tools retains buffer (toolSuccess reset by buffer clear)', () => {
    const stream = [
      J({ type: 'turn_start' }),
      J({ type: 'thinking_delta', delta: 'Let me check status.' }),
      J({ type: 'tool_call', name: 'status' }),
      J({ type: 'tool_result', success: true }),
      // LLM outputs new text between tools
      J({ type: 'text_delta', delta: 'Now let me write the results.' }),
      J({ type: 'tool_call', name: 'write' }),
    ].join('\n') + '\n';

    const track = driveStream('claw-f', stream);

    // text_delta 清 buffer 时同步重置 toolSuccess → 第二个 tool_call 走首轮保留路径
    expect(track.currentTool).toBe('write');
    expect(track.toolSuccess).toBeNull();
    expect(track.textBuffer).toBe('Now let me write the results.');
    expect(track.bufferType).toBe('text');
    expect(track.clearOnNextDelta).toBe(true);
  });
});
