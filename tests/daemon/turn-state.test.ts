/** Phase 2135 Step B：daemon-owned turn-state store 协议测试。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  DAEMON_TURN_STATE_FILE,
  createDaemonTurnStateStore,
  readDaemonTurnState,
} from '../../src/daemon/turn-state.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

describe('daemon turn-state store (phase 2135 Step B)', () => {
  let agentDir: string;
  let agentFs: NodeFileSystem;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `daemon-turn-state-${randomUUID()}`);
    fs.mkdirSync(agentDir, { recursive: true });
    agentFs = new NodeFileSystem({ baseDir: agentDir });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function makeStore(now: () => number = () => 1_000) {
    return createDaemonTurnStateStore({ fs: agentFs, clawId: 'motion', daemonPid: 4242, now });
  }

  function writeRaw(value: unknown): void {
    agentFs.writeAtomicSync(DAEMON_TURN_STATE_FILE, typeof value === 'string' ? value : JSON.stringify(value));
  }

  it('turnStart/turnEnd roundtrip：身份、时间、revision 与原子文件路径正确', () => {
    let now = 1_000;
    const store = makeStore(() => now);
    expect(readDaemonTurnState(agentFs).kind).toBe('missing');

    store.turnStart();
    const active = readDaemonTurnState(agentFs);
    expect(active).toEqual({
      kind: 'ok',
      fact: {
        schema_version: 1,
        phase: 'active',
        revision: 1,
        updatedAtMs: 1_000,
        startedAtMs: 1_000,
        clawId: 'motion',
        daemonPid: 4242,
      },
    });
    expect(fs.existsSync(path.join(agentDir, DAEMON_TURN_STATE_FILE))).toBe(true);

    now = 2_000;
    store.turnEnd();
    const idle = readDaemonTurnState(agentFs);
    expect(idle.kind).toBe('ok');
    if (idle.kind !== 'ok') return;
    expect(idle.fact).toEqual({
      schema_version: 1,
      phase: 'idle',
      revision: 2,
      updatedAtMs: 2_000,
      clawId: 'motion',
      daemonPid: 4242,
    });
  });

  it('turnFinish 幂等：已为 idle 时不重写且不推进 revision', () => {
    let now = 1_000;
    const store = makeStore(() => now);
    store.turnStart();
    now = 2_000;
    store.turnFinish();
    const before = agentFs.readSync(DAEMON_TURN_STATE_FILE);

    now = 3_000;
    store.turnFinish();
    expect(agentFs.readSync(DAEMON_TURN_STATE_FILE)).toBe(before);
    const read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.revision).toBe(2);
  });

  it.each([
    ['turnEnd'],
    ['turnInterrupted'],
    ['turnError'],
  ] as const)('%s 收束 idle 并推进 revision', (terminal) => {
    let now = 1_000;
    const store = makeStore(() => now);
    store.turnStart();
    now = 2_000;
    store[terminal]();

    const read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.phase).toBe('idle');
    expect(read.kind === 'ok' && read.fact.revision).toBe(2);
    expect(read.kind === 'ok' && read.fact.updatedAtMs).toBe(2_000);
  });

  it('reconcileIdle 重读最新磁盘 revision，而非使用构造时快照', () => {
    let now = 5_000;
    const store = makeStore(() => now);
    writeRaw({
      schema_version: 1,
      phase: 'active',
      revision: 41,
      updatedAtMs: 4_000,
      startedAtMs: 4_000,
      clawId: 'motion',
      daemonPid: 4242,
    });

    store.reconcileIdle();
    let read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.revision).toBe(42);
    expect(read.kind === 'ok' && read.fact.phase).toBe('idle');

    now = 6_000;
    store.turnStart();
    read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.revision).toBe(43);
    expect(read.kind === 'ok' && read.fact.phase).toBe('active');
  });

  it('refreshActive 刷新长 turn 时间但保留 revision 与 startedAtMs', () => {
    let now = 1_000;
    const store = makeStore(() => now);
    store.turnStart();

    now = 500_000;
    store.refreshActive();
    const active = readDaemonTurnState(agentFs);
    expect(active).toEqual({
      kind: 'ok',
      fact: {
        schema_version: 1,
        phase: 'active',
        revision: 1,
        updatedAtMs: 500_000,
        startedAtMs: 1_000,
        clawId: 'motion',
        daemonPid: 4242,
      },
    });

    store.turnEnd();
    const idle = agentFs.readSync(DAEMON_TURN_STATE_FILE);
    now = 600_000;
    store.refreshActive();
    expect(agentFs.readSync(DAEMON_TURN_STATE_FILE)).toBe(idle);
  });

  it('active 可携带可选 traceId', () => {
    writeRaw({
      schema_version: 1,
      phase: 'active',
      revision: 1,
      updatedAtMs: 1,
      startedAtMs: 1,
      traceId: 'trace-1',
      clawId: 'motion',
      daemonPid: 1,
    });
    const read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.phase === 'active' && read.fact.traceId).toBe('trace-1');
  });

  it('JSON 损坏与 stale schema 均返回 corrupt', () => {
    writeRaw('{not json');
    expect(readDaemonTurnState(agentFs).kind).toBe('corrupt');

    const staleStates = [
      { schema_version: 2, phase: 'idle', revision: 1, updatedAtMs: 1, clawId: 'motion', daemonPid: 1 },
      { schema_version: 1, phase: 'active', revision: 1, updatedAtMs: 1, clawId: 'motion', daemonPid: 1 },
      { schema_version: 1, phase: 'idle', revision: 1, updatedAtMs: 1, startedAtMs: 1, clawId: 'motion', daemonPid: 1 },
      { schema_version: 1, phase: 'idle', revision: '1', updatedAtMs: 1, clawId: 'motion', daemonPid: 1 },
      { schema_version: 1, phase: 'idle', revision: 1, updatedAtMs: 1, clawId: 'motion', daemonPid: 1, extra: true },
    ];
    for (const stale of staleStates) {
      writeRaw(stale);
      expect(readDaemonTurnState(agentFs).kind).toBe('corrupt');
    }
  });

  it('missing/corrupt 后可从 revision 1 重建，finish 收束 idle', () => {
    const store = makeStore();
    store.turnFinish();
    let read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.revision).toBe(1);
    expect(read.kind === 'ok' && read.fact.phase).toBe('idle');

    writeRaw('{broken');
    const previous = store.reconcileIdle();
    expect(previous.kind).toBe('corrupt');
    read = readDaemonTurnState(agentFs);
    expect(read.kind === 'ok' && read.fact.revision).toBe(1);
    expect(read.kind === 'ok' && read.fact.phase).toBe('idle');
  });
});
