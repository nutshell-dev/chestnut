/** Phase 2135 Step B：motion viewport 仅从 daemon turn-state + heartbeat 恢复。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  DAEMON_HEARTBEAT_FILE,
  DAEMON_TURN_STATE_FILE,
} from '../../src/daemon/index.js';
import { recoverMotionTurnState } from '../../src/viewport/chat-viewport-turn-recovery.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const NOW = 1_000_000;

describe('motion viewport turn recovery (phase 2135 Step B)', () => {
  let agentDir: string;
  let agentFs: NodeFileSystem;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `motion-turn-recovery-${randomUUID()}`);
    fs.mkdirSync(agentDir, { recursive: true });
    agentFs = new NodeFileSystem({ baseDir: agentDir });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function writeTurn(overrides: Record<string, unknown> = {}): void {
    agentFs.writeAtomicSync(DAEMON_TURN_STATE_FILE, JSON.stringify({
      schema_version: 1,
      phase: 'active',
      revision: 7,
      updatedAtMs: NOW - 1_000,
      startedAtMs: NOW - 2_000,
      clawId: 'motion',
      daemonPid: 4242,
      ...overrides,
    }));
  }

  function writeHeartbeat(overrides: Record<string, unknown> = {}): void {
    agentFs.writeAtomicSync(DAEMON_HEARTBEAT_FILE, JSON.stringify({
      schema_version: 1,
      ts: NOW - 1_000,
      pid: 4242,
      ...overrides,
    }));
  }

  function recover(options: {
    heartbeatFreshnessMs?: number;
    turnStateFreshnessMs?: number;
  } = {}) {
    const turnTracker = { begin: vi.fn(), forceReset: vi.fn() };
    const audit = { write: vi.fn() };
    recoverMotionTurnState({
      fs: agentFs,
      clawId: 'motion',
      turnTracker,
      audit,
      now: () => NOW,
      ...options,
    });
    return { turnTracker, audit };
  }

  function expectReset(turnTracker: ReturnType<typeof recover>['turnTracker']): void {
    expect(turnTracker.begin).not.toHaveBeenCalled();
    expect(turnTracker.forceReset).toHaveBeenCalledTimes(1);
  }

  it('fresh active + 同 claw/PID/heartbeat 时恢复 active', () => {
    writeTurn();
    writeHeartbeat();
    const { turnTracker } = recover();
    expect(turnTracker.begin).toHaveBeenCalledTimes(1);
    expect(turnTracker.forceReset).not.toHaveBeenCalled();
  });

  it('idle 即使 heartbeat fresh 也 forceReset', () => {
    writeTurn({ phase: 'idle', startedAtMs: undefined });
    writeHeartbeat();
    expectReset(recover().turnTracker);
  });

  it.each([
    ['turn-state stale', NOW - 300_001, NOW - 1_000],
    ['heartbeat stale', NOW - 1_000, NOW - 180_001],
    ['turn-state future', NOW + 1, NOW - 1_000],
    ['heartbeat future', NOW - 1_000, NOW + 1],
  ] as const)('%s 时 forceReset', (_name, turnUpdatedAtMs, heartbeatTs) => {
    writeTurn({ updatedAtMs: turnUpdatedAtMs });
    writeHeartbeat({ ts: heartbeatTs });
    expectReset(recover().turnTracker);
  });

  it('daemon heartbeat 缺失时 forceReset', () => {
    writeTurn();
    expectReset(recover().turnTracker);
  });

  it.each([
    ['clawId', { clawId: 'other' }, {}],
    ['daemonPid', { daemonPid: 4343 }, {}],
    ['heartbeat pid', {}, { pid: 4343 }],
  ] as const)('%s 不符时 forceReset', (_name, turn, heartbeat) => {
    writeTurn(turn);
    writeHeartbeat(heartbeat);
    expectReset(recover().turnTracker);
  });

  it.each([
    ['turn-state corrupt', '{broken', undefined],
    ['turn-state schema invalid', JSON.stringify({ schema_version: 2 }), undefined],
    ['heartbeat corrupt', undefined, '{broken'],
  ] as const)('%s 时审计并 forceReset', (_name, turnRaw, heartbeatRaw) => {
    if (turnRaw === undefined) writeTurn();
    else agentFs.writeAtomicSync(DAEMON_TURN_STATE_FILE, turnRaw);
    if (heartbeatRaw === undefined) writeHeartbeat();
    else agentFs.writeAtomicSync(DAEMON_HEARTBEAT_FILE, heartbeatRaw);

    const { turnTracker, audit } = recover();
    expectReset(turnTracker);
    expect(audit.write).toHaveBeenCalledWith(
      'viewport_motion_turn_recovery_failed',
      expect.stringMatching(/^source=/),
      expect.stringMatching(/^reason=/),
    );
  });

  it('active startedAtMs 在未来时 forceReset', () => {
    writeTurn({ startedAtMs: NOW + 1 });
    writeHeartbeat();
    expectReset(recover().turnTracker);
  });

  it('可注入新鲜度阈值，且阈值边界仍视为 fresh', () => {
    writeTurn({ updatedAtMs: NOW - 11 });
    writeHeartbeat({ ts: NOW - 10 });
    expectReset(recover({ turnStateFreshnessMs: 10 }).turnTracker);

    const { turnTracker } = recover({ turnStateFreshnessMs: 11, heartbeatFreshnessMs: 10 });
    expect(turnTracker.begin).toHaveBeenCalledTimes(1);
    expect(turnTracker.forceReset).not.toHaveBeenCalled();
  });
});
