/**
 * Phase 1878 Step B: Daemon 心跳协议（heartbeat-fact）单元测试。
 *
 * 覆盖：写读 roundtrip / missing（升级窗口 unknown）/ corrupt（JSON 与 schema 两类）。
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

describe('daemon heartbeat fact protocol (phase 1878 Step B)', () => {
  let agentDir: string;
  let agentFs: NodeFileSystem;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `daemon-heartbeat-fact-${randomUUID()}`);
    fs.mkdirSync(agentDir, { recursive: true });
    agentFs = new NodeFileSystem({ baseDir: agentDir });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('write → read roundtrip：daemon-owned namespace + ts/pid 事实', () => {
    writeDaemonHeartbeat(agentFs, 1_700_000_000_000);
    expect(fs.existsSync(path.join(agentDir, DAEMON_HEARTBEAT_FILE))).toBe(true);
    // daemon-owned namespace（对齐 1873 G DAEMON_STATE_DIR）
    expect(DAEMON_HEARTBEAT_FILE).toBe('daemon/heartbeat.json');
    const read = readDaemonHeartbeat(agentFs);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.fact.schema_version).toBe(1);
    expect(read.fact.ts).toBe(1_700_000_000_000);
    expect(read.fact.pid).toBe(process.pid);
  });

  it('重复写 → ts 覆盖（单调推进语义）', () => {
    writeDaemonHeartbeat(agentFs, 1000);
    writeDaemonHeartbeat(agentFs, 2000);
    const read = readDaemonHeartbeat(agentFs);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.fact.ts).toBe(2000);
  });

  it('文件缺失 → missing（升级窗口显式 unknown 语义）', () => {
    expect(readDaemonHeartbeat(agentFs).kind).toBe('missing');
  });

  it('JSON 损坏 → corrupt（不抛、不静默折 ok）', () => {
    fs.mkdirSync(path.dirname(path.join(agentDir, DAEMON_HEARTBEAT_FILE)), { recursive: true });
    fs.writeFileSync(path.join(agentDir, DAEMON_HEARTBEAT_FILE), '{not json');
    const read = readDaemonHeartbeat(agentFs);
    expect(read.kind).toBe('corrupt');
  });

  it('schema 不符 → corrupt', () => {
    fs.mkdirSync(path.dirname(path.join(agentDir, DAEMON_HEARTBEAT_FILE)), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, DAEMON_HEARTBEAT_FILE),
      JSON.stringify({ schema_version: 1, ts: 'not-a-number' }),
    );
    expect(readDaemonHeartbeat(agentFs).kind).toBe('corrupt');
  });
});
