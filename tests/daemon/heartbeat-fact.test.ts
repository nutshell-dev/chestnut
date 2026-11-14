/**
 * Phase 1878 Step B / Phase 2153 Step B2: Daemon 心跳协议单元测试。
 *
 * 覆盖：schema v2 roundtrip、legacy/未来 schema、字段校验与 atomic write failure。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  DAEMON_HEARTBEAT_FILE,
  writeDaemonHeartbeat,
  readDaemonHeartbeat,
} from '../../src/daemon/heartbeat-fact.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const IDENTITY = { generationId: 'generation-a', startTime: 'Fri Nov 13 10:00:00 2026' };

describe('daemon heartbeat fact protocol (phase 2153 Step B2)', () => {
  let agentDir: string;
  let agentFs: NodeFileSystem;
  let heartbeatPath: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `daemon-heartbeat-fact-${randomUUID()}`);
    fs.mkdirSync(agentDir, { recursive: true });
    agentFs = new NodeFileSystem({ baseDir: agentDir });
    heartbeatPath = path.join(agentDir, DAEMON_HEARTBEAT_FILE);
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function writeRaw(value: unknown): void {
    fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
    fs.writeFileSync(heartbeatPath, typeof value === 'string' ? value : JSON.stringify(value));
  }

  function validFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 2,
      ts: 1_700_000_000_000,
      pid: process.pid,
      generation_id: IDENTITY.generationId,
      start_time: IDENTITY.startTime,
      ...overrides,
    };
  }

  it('write → read roundtrip：v2 绑定 ts/pid/generation/start_time', () => {
    writeDaemonHeartbeat(agentFs, 1_700_000_000_000, IDENTITY);
    expect(fs.existsSync(heartbeatPath)).toBe(true);
    expect(DAEMON_HEARTBEAT_FILE).toBe('daemon/heartbeat.json');
    expect(readDaemonHeartbeat(agentFs)).toEqual({ kind: 'ok', fact: validFact() });
  });

  it('重复写 → ts 覆盖，activation identity 保持不变', () => {
    writeDaemonHeartbeat(agentFs, 1000, IDENTITY);
    writeDaemonHeartbeat(agentFs, 2000, IDENTITY);
    const read = readDaemonHeartbeat(agentFs);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.fact).toMatchObject({
        ts: 2000,
        generation_id: IDENTITY.generationId,
        start_time: IDENTITY.startTime,
      });
    }
  });

  it.each([
    ['missing', undefined],
    ['empty generation', { generationId: '', startTime: IDENTITY.startTime }],
    ['empty start time', { generationId: IDENTITY.generationId, startTime: '' }],
  ] as const)('identity %s → 写失败，不生成伪心跳', (_name, identity) => {
    expect(() => writeDaemonHeartbeat(agentFs, 1000, identity)).toThrow('daemon heartbeat identity unavailable');
    expect(fs.existsSync(heartbeatPath)).toBe(false);
  });

  it('文件缺失 → missing（升级窗口显式 unknown 语义）', () => {
    expect(readDaemonHeartbeat(agentFs).kind).toBe('missing');
  });

  it('JSON 损坏 → corrupt，原文保留', () => {
    writeRaw('{not json');
    expect(readDaemonHeartbeat(agentFs).kind).toBe('corrupt');
    expect(fs.readFileSync(heartbeatPath, 'utf8')).toBe('{not json');
  });

  it('schema v1 → legacy unknown，不得读成 ok 或改写旧文件', () => {
    const legacy = JSON.stringify({ schema_version: 1, ts: 1000, pid: process.pid });
    writeRaw(legacy);
    expect(readDaemonHeartbeat(agentFs)).toEqual({
      kind: 'legacy',
      error: 'legacy schema_version=1',
    });
    expect(fs.readFileSync(heartbeatPath, 'utf8')).toBe(legacy);
  });

  it.each([3, 99, '2'])('未来/未知 schema_version=%s → corrupt，不回退 v2', (schemaVersion) => {
    writeRaw(validFact({ schema_version: schemaVersion }));
    expect(readDaemonHeartbeat(agentFs).kind).toBe('corrupt');
  });

  it.each([
    ['ts missing', { ts: undefined }],
    ['ts string', { ts: '1000' }],
    ['ts NaN', { ts: Number.NaN }],
    ['ts Infinity', { ts: Number.POSITIVE_INFINITY }],
    ['pid missing', { pid: undefined }],
    ['pid zero', { pid: 0 }],
    ['pid negative', { pid: -1 }],
    ['pid fractional', { pid: 1.5 }],
    ['pid Infinity', { pid: Number.POSITIVE_INFINITY }],
    ['generation missing', { generation_id: undefined }],
    ['generation empty', { generation_id: '' }],
    ['generation blank', { generation_id: '   ' }],
    ['generation wrong type', { generation_id: 42 }],
    ['start_time missing', { start_time: undefined }],
    ['start_time empty', { start_time: '' }],
    ['start_time blank', { start_time: '   ' }],
    ['start_time wrong type', { start_time: 42 }],
  ])('字段错误：%s → corrupt', (_name, override) => {
    writeRaw(validFact(override));
    expect(readDaemonHeartbeat(agentFs).kind).toBe('corrupt');
  });

  it('非有限 number 的原始 JSON 表示 → corrupt', () => {
    writeRaw('{"schema_version":2,"ts":1e400,"pid":123,"generation_id":"g","start_time":"s"}');
    expect(readDaemonHeartbeat(agentFs)).toEqual({ kind: 'corrupt', error: 'invalid heartbeat ts' });
  });

  it('atomic write failure 向 caller 抛出，旧心跳原文不被破坏', () => {
    writeDaemonHeartbeat(agentFs, 1000, IDENTITY);
    const before = fs.readFileSync(heartbeatPath, 'utf8');
    const failingFs = Object.create(agentFs) as NodeFileSystem;
    failingFs.writeAtomicSync = () => { throw new Error('injected atomic write failure'); };

    expect(() => writeDaemonHeartbeat(failingFs, 2000, IDENTITY)).toThrow('injected atomic write failure');
    expect(fs.readFileSync(heartbeatPath, 'utf8')).toBe(before);
  });
});
