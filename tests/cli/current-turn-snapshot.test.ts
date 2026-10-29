/**
 * current-turn-snapshot tests（phase 2003 Step B/D）
 *
 * readCurrentTurnSnapshot 单元矩阵：活跃 turn / 三种终止 / 空文件 / 不存在 /
 * 残缺末行边界 / 多 trace 交错保留 / turn_start 未找到 fallback。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as nodeFs from 'fs';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { readCurrentTurnSnapshot } from '../../src/foundation/stream/current-turn-snapshot.js';

let tmpRoot: string;
let fs: NodeFileSystem;

function writeLines(lines: string[]): number {
  const content = lines.map((l) => l + '\n').join('');
  nodeFs.writeFileSync(path.join(tmpRoot, 'stream.jsonl'), content);
  return Buffer.byteLength(content, 'utf-8');
}

function ev(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: 1, type, ...extra });
}

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpRoot = path.join(os.tmpdir(), `phase2003-snapshot-${randomUUID()}`);
  nodeFs.mkdirSync(tmpRoot, { recursive: true });
  fs = new NodeFileSystem({ baseDir: tmpRoot });
});

afterEach(() => {
  nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readCurrentTurnSnapshot', () => {
  it('文件不存在 / 空文件：active=false，tailOffset=0', () => {
    expect(readCurrentTurnSnapshot(fs, 'stream.jsonl'))
      .toEqual({ active: false, events: [], tailOffset: 0 });
    nodeFs.writeFileSync(path.join(tmpRoot, 'stream.jsonl'), '');
    expect(readCurrentTurnSnapshot(fs, 'stream.jsonl'))
      .toEqual({ active: false, events: [], tailOffset: 0 });
  });

  it('活跃 turn：返回自 turn_start 起全部完整事件，tailOffset=文件 size', () => {
    const size = writeLines([
      ev('turn_start', { trace_id: 't0' }),
      ev('turn_end', { trace_id: 't0' }),
      ev('turn_start', { trace_id: 't1' }),
      ev('thinking_delta', { delta: '思考中', trace_id: 't1' }),
      ev('send_content_delta', { delta: '你好', trace_id: 'r1' }),
    ]);
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.active).toBe(true);
    expect(snap.tailOffset).toBe(size);
    // 只含最近 turn 的事件（turn_start t0 / turn_end t0 不进入）
    expect(snap.events.map((e) => e.type)).toEqual(['turn_start', 'thinking_delta', 'send_content_delta']);
  });

  it.each(['turn_end', 'turn_error', 'turn_interrupted'])('已终止 turn（%s）：active=false，events 为空', (terminal) => {
    const size = writeLines([
      ev('turn_start', { trace_id: 't1' }),
      ev('send_content_delta', { delta: '旧回复', trace_id: 'r1' }),
      ev(terminal, { trace_id: 't1' }),
    ]);
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.active).toBe(false);
    expect(snap.events).toEqual([]);
    expect(snap.tailOffset).toBe(size);
  });

  it('残缺末行（无尾换行）不进快照、不计入边界；reader 从边界重读', () => {
    const complete = writeLines([ev('turn_start', { trace_id: 't1' }), ev('thinking_delta', { delta: '完整行', trace_id: 't1' })]);
    nodeFs.appendFileSync(path.join(tmpRoot, 'stream.jsonl'), '{"ts":9,"type":"thinking_delta","delta":"残');
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.active).toBe(true);
    expect(snap.events).toHaveLength(2);
    expect(snap.tailOffset).toBe(complete);
  });

  it('活跃 turn 保留连续用户消息 sources 及其原始顺序；已结束历史不进入快照', () => {
    writeLines([
      ev('turn_start', { trace_id: 'old', sources: [{ type: 'user_chat', text: '旧消息' }] }),
      ev('turn_end', { trace_id: 'old' }),
      ev('turn_start', {
        trace_id: 'active-turn',
        sources: [
          { type: 'user_chat', text: '第一条' },
          { type: 'user_inbox_message', text: '第二条' },
        ],
      }),
      ev('send_content_delta', { delta: '回复', trace_id: 'r1' }),
    ]);
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.active).toBe(true);
    expect(snap.events).toHaveLength(2);
    expect(snap.events[0]).toMatchObject({
      type: 'turn_start',
      trace_id: 'active-turn',
      sources: [{ type: 'user_chat', text: '第一条' }, { type: 'user_inbox_message', text: '第二条' }],
    });
    expect(JSON.stringify(snap.events)).not.toContain('旧消息');
  });

  it('多 trace 交错事件原样保留（压缩分桶归调用方 mapper）', () => {
    writeLines([
      ev('turn_start', { trace_id: 't1' }),
      ev('send_content_delta', { delta: '甲一', trace_id: 'A' }),
      ev('send_content_delta', { delta: '乙一', trace_id: 'B' }),
      ev('send_content_delta', { delta: '甲二', trace_id: 'A' }),
      ev('send_content_delta', { delta: '乙二', trace_id: 'B' }),
    ]);
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.active).toBe(true);
    expect(snap.events.map((e) => [e.type, (e as { trace_id?: string }).trace_id]))
      .toEqual([['turn_start', 't1'], ['send_content_delta', 'A'], ['send_content_delta', 'B'], ['send_content_delta', 'A'], ['send_content_delta', 'B']]);
  });

  it('无 turn_start（窗口内找不到）：active=false，从文件尾 tail', () => {
    const size = writeLines([ev('session_boundary'), ev('provider_info', { name: 'kimi' })]);
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.active).toBe(false);
    expect(snap.events).toEqual([]);
    expect(snap.tailOffset).toBe(size);
  });

  it('CJK 内容字节边界正确（tailOffset 以字节计）', () => {
    const size = writeLines([ev('turn_start', { trace_id: 't1' }), ev('send_content_delta', { delta: '中文内容字节', trace_id: 'r1' })]);
    const snap = readCurrentTurnSnapshot(fs, 'stream.jsonl');
    expect(snap.tailOffset).toBe(size);
    expect(snap.active).toBe(true);
  });
});
