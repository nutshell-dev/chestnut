import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nativePath from 'path';
import * as nativeFs from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import {
  createPerResourceStreamWriter,
  PerResourceStreamWriter,
  STREAM_FILE,
} from '../../src/foundation/stream/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createAuditWriter, type AuditLog } from '../../src/foundation/audit/index.js';

describe('PerResourceStreamWriter', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: AuditLog;
  let auditPath: string;
  let streamPath: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('per-resource-stream-');
    fs = new NodeFileSystem({ baseDir: tempDir });
    auditPath = nativePath.join(tempDir, 'audit.tsv');
    audit = createAuditWriter(fs, 'audit.tsv');
    streamPath = nativePath.join(tempDir, 'sub', STREAM_FILE);
    fs.ensureDirSync('sub');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('appends JSONL line per event (phase 1152 G.1: void signature)', () => {
    const w = createPerResourceStreamWriter(fs, `sub/${STREAM_FILE}`, audit);
    expect(w).toBeInstanceOf(PerResourceStreamWriter);
    expect(() => w.write({ ts: 100, type: 'task_attempt_start', taskId: 'T1' })).not.toThrow();
    expect(() => w.write({ ts: 200, type: 'thinking_delta', delta: 'hi' })).not.toThrow();
    const content = nativeFs.readFileSync(streamPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: 100, type: 'task_attempt_start', taskId: 'T1' });
    expect(JSON.parse(lines[1])).toEqual({ ts: 200, type: 'thinking_delta', delta: 'hi' });
  });

  it('emits APPEND_FAILED on write error (phase 1152 G.1: void signature)', () => {
    // 传绝对路径超出 baseDir → resolveAndCheck 抛 PermissionError
    const w = createPerResourceStreamWriter(fs, '/outside/base/stream.jsonl', audit);
    expect(() => w.write({ ts: 100, type: 'task_started', taskId: 'T2' })).not.toThrow();
    const auditContent = nativeFs.readFileSync(auditPath, 'utf-8');
    expect(auditContent).toMatch(/stream_append_failed/);
    expect(auditContent).toMatch(/path=\/outside\/base\/stream\.jsonl/);
    expect(auditContent).toMatch(/type=task_started/);
  });

  it('does not require open()/close() lifecycle', () => {
    const w = createPerResourceStreamWriter(fs, `sub/${STREAM_FILE}`, audit);
    // 任何 open/close 方法都不应在公共接口（结构性、tsc 编译期保障）
    expect('open' in w).toBe(false);
    expect('close' in w).toBe(false);
    // 即用即写、不抛
    expect(() => w.write({ ts: 100, type: 'turn_start' })).not.toThrow();
  });

  it('factory returns distinct instances per call', () => {
    const w1 = createPerResourceStreamWriter(fs, `sub/${STREAM_FILE}`, audit);
    const w2 = createPerResourceStreamWriter(fs, `sub/${STREAM_FILE}`, audit);
    expect(w1).not.toBe(w2);
    expect(w1).toBeInstanceOf(PerResourceStreamWriter);
    expect(w2).toBeInstanceOf(PerResourceStreamWriter);
  });
});
