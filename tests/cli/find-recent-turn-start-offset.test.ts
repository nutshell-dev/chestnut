/**
 * findRecentTurnStartOffset tests
 *
 * 修 spinner 不显示 bug：chat-viewport 启动晚于 daemon / 跳过 turn_start + llm_start events / spinner 没启动
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findRecentTurnStartOffset } from '../../src/foundation/stream/turn-start-offset.js';
import { createDirContext } from '../../src/foundation/process-manager/factories.js';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('findRecentTurnStartOffset', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fsNative.mkdtempSync(path.join(os.tmpdir(), 'find-turn-start-'));
  });

  // phase 999 r121 P fork C.D.1: cleanup tmpDir leak per test run
  afterEach(() => {
    if (tmpDir) fsNative.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('文件不存在 / 返 0', () => {
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    expect(findRecentTurnStartOffset(fs, 'nonexistent.jsonl')).toBe(0);
  });

  it('空文件 / 返 0', () => {
    fsNative.writeFileSync(path.join(tmpDir, 'stream.jsonl'), '');
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    expect(findRecentTurnStartOffset(fs, 'stream.jsonl')).toBe(0);
  });

  it('无 turn_start events / 返 file size (fallback to tail)', () => {
    const content = '{"type":"daemon_started"}\n{"type":"llm_call"}\n';
    fsNative.writeFileSync(path.join(tmpDir, 'stream.jsonl'), content);
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    const offset = findRecentTurnStartOffset(fs, 'stream.jsonl');
    expect(offset).toBe(content.length);
  });

  it('单个 turn_start / 返其 byte offset', () => {
    const line1 = '{"type":"daemon_started","ts":1}\n';
    const line2 = '{"type":"turn_start","ts":2,"sources":[]}\n';
    fsNative.writeFileSync(path.join(tmpDir, 'stream.jsonl'), line1 + line2);
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    const offset = findRecentTurnStartOffset(fs, 'stream.jsonl');
    expect(offset).toBe(line1.length);  // turn_start line 起点 = line1.length
  });

  it('多个 turn_start / 返最近 (last) 的 offset', () => {
    const turn1Line = '{"type":"turn_start","ts":1}\n';
    const turnEnd = '{"type":"turn_end"}\n';
    const turn2Line = '{"type":"turn_start","ts":2}\n';
    const llmStartLine = '{"type":"llm_start"}\n';
    const content = turn1Line + turnEnd + turn2Line + llmStartLine;
    fsNative.writeFileSync(path.join(tmpDir, 'stream.jsonl'), content);
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    const offset = findRecentTurnStartOffset(fs, 'stream.jsonl');
    // 最近 turn_start 起点 = turn1Line + turnEnd 之后
    expect(offset).toBe(turn1Line.length + turnEnd.length);
  });

  it('scanBytes 限制 / 仅扫文件末尾段', () => {
    const oldContent = 'x'.repeat(100000) + '\n';  // 100KB+ 旧内容（无 turn_start）
    const recentTurn = '{"type":"turn_start","ts":1}\n';
    const recentLLM = '{"type":"llm_start"}\n';
    const content = oldContent + recentTurn + recentLLM;
    fsNative.writeFileSync(path.join(tmpDir, 'stream.jsonl'), content);
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    const offset = findRecentTurnStartOffset(fs, 'stream.jsonl', 1024);  // 仅扫末尾 1KB
    // 在 1KB scan 内能找到最近 turn_start
    expect(offset).toBe(oldContent.length);
  });

  it('scanBytes 不够 / 没找到 / 返 file size', () => {
    const turnStart = '{"type":"turn_start","ts":1}\n';
    const oldContent = 'x'.repeat(100000) + '\n';
    const content = turnStart + oldContent;  // turn_start 在最早 / 1KB scan 不到
    fsNative.writeFileSync(path.join(tmpDir, 'stream.jsonl'), content);
    const { fs } = createDirContext({ fsFactory }, tmpDir);
    const offset = findRecentTurnStartOffset(fs, 'stream.jsonl', 1024);
    expect(offset).toBe(content.length);  // fallback to tail
  });
});
