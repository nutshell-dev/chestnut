/**
 * Phase 1203 Step A: Watchdog 目录位置 ownership 状态机测试。
 *
 * 反向覆盖（真实 NodeFileSystem、非 mock）：
 * - move 到现存非空目录必失败且 source/destination bytes 不变（协议前提证明）
 * - 两个 candidate 单 winner；active collision 不覆盖
 * - 两个 reclaimer 单 winner；fresh active 不能被 old-token 迟到 rename
 * - 畸形 active fail-closed 并 audit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { setAuditWriter, _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import {
  newWatchdogAttempt,
  prepareCandidate,
  commitOwnership,
  inspectActive,
  inspectTerminal,
  recordGenerationTerminal,
  retireOwnership,
  writeCandidateOutcome,
  WATCHDOG_ACTIVE_DIR,
  WATCHDOG_CANDIDATES_DIR,
  WATCHDOG_OWNERSHIP_DIR,
  WATCHDOG_RETIRED_DIR,
  WATCHDOG_TERMINAL_FILE,
  type WatchdogOwnerRecord,
  type WatchdogGenerationTerminal,
} from '../../src/watchdog/watchdog-ownership.js';

let tmpDir: string;
let chestnutDir: string;
let chestnutFs: NodeFileSystem;
let auditWriter: AuditWriter;
let auditLines: () => string;

function makeRecord(overrides: Partial<WatchdogOwnerRecord> = {}): WatchdogOwnerRecord {
  return { ...newWatchdogAttempt(424242), ...overrides };
}

function readActiveJson(): string {
  return fs.readFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), 'utf-8');
}

beforeEach(() => {
  _resetWatchdogContextForTest();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-ownership-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(chestnutDir, { recursive: true });
  chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
  auditWriter = new AuditWriter(new NodeFileSystem({ baseDir: chestnutDir }), 'audit.tsv', null);
  setAuditWriter(auditWriter);
  auditLines = () =>
    fs.existsSync(path.join(chestnutDir, 'audit.tsv'))
      ? fs.readFileSync(path.join(chestnutDir, 'audit.tsv'), 'utf-8')
      : '';
});

afterEach(() => {
  setAuditWriter(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 1287 Step B: ownership 路径 identity', () => {
  it('目录常量与 Phase 1286 目标布局逐项一致（值不变、归 layout 协议派生）', () => {
    expect(WATCHDOG_OWNERSHIP_DIR).toBe('watchdog');
    expect(WATCHDOG_CANDIDATES_DIR).toBe('watchdog/candidates');
    expect(WATCHDOG_ACTIVE_DIR).toBe('watchdog/active');
    expect(WATCHDOG_RETIRED_DIR).toBe('watchdog/retired');
  });
});

describe('NodeFileSystem move 前提证明（协议依赖 rename 不覆盖非空目录）', () => {
  it('move 目录到现存非空目录失败，source 与 destination bytes 均不变', () => {
    fs.mkdirSync(path.join(chestnutDir, 'src-dir'), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, 'src-dir', 'owner.json'), 'SRC');
    fs.mkdirSync(path.join(chestnutDir, 'dst-dir'), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, 'dst-dir', 'owner.json'), 'DST');

    expect(() => chestnutFs.moveSync('src-dir', 'dst-dir')).toThrow();

    expect(fs.readFileSync(path.join(chestnutDir, 'src-dir', 'owner.json'), 'utf-8')).toBe('SRC');
    expect(fs.readFileSync(path.join(chestnutDir, 'dst-dir', 'owner.json'), 'utf-8')).toBe('DST');
  });

  it('move 目录到不存在的 destination 成功（commit 主路径语义）', () => {
    fs.mkdirSync(path.join(chestnutDir, 'src-dir'), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, 'src-dir', 'owner.json'), 'SRC');

    chestnutFs.moveSync('src-dir', 'dst-dir');

    expect(fs.existsSync(path.join(chestnutDir, 'src-dir'))).toBe(false);
    expect(fs.readFileSync(path.join(chestnutDir, 'dst-dir', 'owner.json'), 'utf-8')).toBe('SRC');
  });
});

describe('prepareCandidate + commitOwnership', () => {
  it('完整 candidate 经 rename 提交为 active owner', () => {
    const record = makeRecord();
    prepareCandidate(chestnutFs, record);

    const prepared = fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, record.attempt_id, 'owner.json'), 'utf-8');
    expect(JSON.parse(prepared)).toMatchObject({
      attempt_id: record.attempt_id,
      owner_token: record.owner_token,
      pid: record.pid,
    });

    const result = commitOwnership(chestnutFs, record);
    expect(result.kind).toBe('committed');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, record.attempt_id))).toBe(false);
    expect(JSON.parse(readActiveJson())).toMatchObject({ owner_token: record.owner_token });
    expect(auditLines()).toContain('watchdog_ownership_attempted');
    expect(auditLines()).toContain('watchdog_ownership_committed');
  });

  it('两个 candidate 单 winner：loser 得 foreign_owned 并重读到 winner record', () => {
    const winner = makeRecord();
    const loser = makeRecord();
    prepareCandidate(chestnutFs, winner);
    prepareCandidate(chestnutFs, loser);

    expect(commitOwnership(chestnutFs, winner).kind).toBe('committed');
    const lostResult = commitOwnership(chestnutFs, loser);

    expect(lostResult.kind).toBe('foreign_owned');
    if (lostResult.kind === 'foreign_owned') {
      expect(lostResult.owner.owner_token).toBe(winner.owner_token);
    }
    // active 未被覆盖；loser candidate 完整保留
    expect(JSON.parse(readActiveJson())).toMatchObject({ owner_token: winner.owner_token });
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, loser.attempt_id, 'owner.json'))).toBe(true);
    expect(auditLines()).toContain('watchdog_ownership_lost');
  });

  it('loser 在自己 candidate 写 immutable outcome（exclusive、不可重写）', () => {
    const winner = makeRecord();
    const loser = makeRecord();
    prepareCandidate(chestnutFs, winner);
    prepareCandidate(chestnutFs, loser);
    commitOwnership(chestnutFs, winner);
    const lostResult = commitOwnership(chestnutFs, loser);
    expect(lostResult.kind).toBe('foreign_owned');
    if (lostResult.kind !== 'foreign_owned') return;

    writeCandidateOutcome(chestnutFs, loser.attempt_id, {
      outcome: 'lost',
      winner_owner_token: lostResult.owner.owner_token,
      winner_pid: lostResult.owner.pid,
      reason: 'active_collision',
    });

    const outcomePath = path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, loser.attempt_id, 'outcome.json');
    expect(JSON.parse(fs.readFileSync(outcomePath, 'utf-8'))).toMatchObject({
      outcome: 'lost',
      winner_owner_token: winner.owner_token,
    });
    // immutable：第二次 exclusive 写必失败
    expect(() =>
      writeCandidateOutcome(chestnutFs, loser.attempt_id, { outcome: 'lost', reason: 'dup' }),
    ).toThrow();
  });

  it('同 attempt 重复 commit 收敛 already_owned（崩溃窗口幂等）', () => {
    const record = makeRecord();
    prepareCandidate(chestnutFs, record);
    expect(commitOwnership(chestnutFs, record).kind).toBe('committed');

    // candidate 已移走 → move 必失败；重读 active 识别出同 attempt
    const again = commitOwnership(chestnutFs, record);
    expect(again.kind).toBe('already_owned');
    if (again.kind === 'already_owned') {
      expect(again.owner.owner_token).toBe(record.owner_token);
    }
  });

  it('畸形 active fail-closed：不覆盖、audit、candidate 保留', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), 'NOT_JSON{{{');

    const record = makeRecord();
    prepareCandidate(chestnutFs, record);
    const result = commitOwnership(chestnutFs, record);

    expect(result.kind).toBe('retryable_failure');
    expect(readActiveJson()).toBe('NOT_JSON{{{');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, record.attempt_id, 'owner.json'))).toBe(true);
    expect(auditLines()).toContain('watchdog_ownership_malformed_active');
  });
});

describe('retireOwnership', () => {
  function seedActive(): WatchdogOwnerRecord {
    const record = makeRecord();
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);
    return record;
  }

  const expectedOf = (r: WatchdogOwnerRecord) => ({
    attemptId: r.attempt_id, ownerToken: r.owner_token, pid: r.pid,
  });

  it('匹配 generation 整体退休到 retired/<owner-token>，内容完整保留', () => {
    const record = seedActive();
    const result = retireOwnership(chestnutFs, expectedOf(record), 'shutdown');

    expect(result.kind).toBe('retired');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR))).toBe(false);
    const retired = JSON.parse(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token, 'owner.json'), 'utf-8'));
    expect(retired).toMatchObject({ attempt_id: record.attempt_id, owner_token: record.owner_token });
    expect(auditLines()).toContain('watchdog_ownership_retired');
    expect(auditLines()).toContain('reason=shutdown');
  });

  it('旧 generation 迟到 shutdown：attempt/token/pid 不匹配 → mismatch，fresh active 不动', () => {
    const stale = makeRecord();
    const fresh = seedActive();
    const result = retireOwnership(chestnutFs, expectedOf(stale), 'shutdown');

    expect(result.kind).toBe('mismatch');
    expect(JSON.parse(readActiveJson())).toMatchObject({ owner_token: fresh.owner_token });
  });

  it('两个 reclaimer 竞争旧 generation：首个 retire 成功，迟到者得 no_active', () => {
    const record = seedActive();
    const first = retireOwnership(chestnutFs, expectedOf(record), 'stale_recovery');
    expect(first.kind).toBe('retired');

    const second = retireOwnership(chestnutFs, expectedOf(record), 'stale_recovery');
    expect(second.kind).toBe('no_active');
  });

  it('retired/<token> 已存在非空 → collision 安全网：active 不被移动', () => {
    const record = seedActive();
    // 另一 reclaimer 已处置过该 token（destination 永久非空）
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token, 'owner.json'), 'PRIOR');

    const result = retireOwnership(chestnutFs, expectedOf(record), 'stale_recovery');

    expect(result.kind).toBe('collision');
    expect(JSON.parse(readActiveJson())).toMatchObject({ owner_token: record.owner_token });
    expect(fs.readFileSync(
      path.join(chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token, 'owner.json'), 'utf-8')).toBe('PRIOR');
  });

  it('active 不存在 → no_active', () => {
    const result = retireOwnership(chestnutFs, expectedOf(makeRecord()), 'shutdown');
    expect(result.kind).toBe('no_active');
  });

  it('畸形 active → malformed_active + audit，不做任何移动', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), '{broken');

    const result = retireOwnership(chestnutFs, expectedOf(makeRecord()), 'stale_recovery');

    expect(result.kind).toBe('malformed_active');
    expect(fs.existsSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'))).toBe(true);
    expect(auditLines()).toContain('watchdog_ownership_malformed_active');
  });
});

describe('inspectActive', () => {
  it('无 active → none；合法 → ok；畸形 → malformed', () => {
    expect(inspectActive(chestnutFs).status).toBe('none');

    const record = makeRecord();
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);
    const ok = inspectActive(chestnutFs);
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') expect(ok.owner.attempt_id).toBe(record.attempt_id);
  });

  it('schema_version 不符 → malformed', () => {
    const record = makeRecord({ schema_version: 999 });
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);
    expect(inspectActive(chestnutFs).status).toBe('malformed');
  });
});

describe('recordGenerationTerminal', () => {
  function seedActive(): WatchdogOwnerRecord {
    const record = makeRecord();
    prepareCandidate(chestnutFs, record);
    commitOwnership(chestnutFs, record);
    return record;
  }

  const expectedOf = (r: WatchdogOwnerRecord) => ({
    attemptId: r.attempt_id, ownerToken: r.owner_token, pid: r.pid,
  });

  it('为当前 generation 写 stopped terminal 并 exclusive 不可覆盖', () => {
    const record = seedActive();
    const terminal: WatchdogGenerationTerminal = {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    };
    const first = recordGenerationTerminal(chestnutFs, expectedOf(record), terminal);
    expect(first.kind).toBe('recorded');

    const second = recordGenerationTerminal(chestnutFs, expectedOf(record), {
      kind: 'unclean', detected_at: new Date().toISOString(), detected_by_pid: 123,
    });
    expect(second.kind).toBe('already_recorded');
    if (second.kind === 'already_recorded') expect(second.terminal.kind).toBe('stopped');

    const read = inspectTerminal(chestnutFs);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.terminal.kind).toBe('stopped');
  });

  it('generation 不匹配 → mismatch，不动 active', () => {
    const record = seedActive();
    const other = makeRecord();
    const result = recordGenerationTerminal(chestnutFs, expectedOf(other), {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    });
    expect(result.kind).toBe('mismatch');
    expect(inspectTerminal(chestnutFs).status).toBe('none');
    expect(JSON.parse(readActiveJson()).owner_token).toBe(record.owner_token);
  });

  it('无 active → no_active', () => {
    const result = recordGenerationTerminal(chestnutFs, expectedOf(makeRecord()), {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    });
    expect(result.kind).toBe('no_active');
  });

  it('active 畸形 → malformed，不覆盖', () => {
    fs.mkdirSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, 'owner.json'), '{broken');
    const result = recordGenerationTerminal(chestnutFs, expectedOf(makeRecord()), {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    });
    expect(result.kind).toBe('malformed');
  });

  it('terminal 文件已存在但畸形 → malformed，不覆盖', () => {
    const record = seedActive();
    fs.writeFileSync(path.join(chestnutDir, WATCHDOG_ACTIVE_DIR, WATCHDOG_TERMINAL_FILE), 'NOT_JSON');
    const result = recordGenerationTerminal(chestnutFs, expectedOf(record), {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    });
    expect(result.kind).toBe('malformed');
  });

  it('late writer：active 已退休后无法再写 terminal，retired terminal 保持不变（overwrite fixture）', () => {
    const record = seedActive();
    const terminal: WatchdogGenerationTerminal = {
      kind: 'stopped', signal: 'SIGTERM', recorded_at: new Date().toISOString(),
    };
    expect(recordGenerationTerminal(chestnutFs, expectedOf(record), terminal).kind).toBe('recorded');

    const retireResult = retireOwnership(chestnutFs, expectedOf(record), 'shutdown');
    expect(retireResult.kind).toBe('retired');

    // 同一旧 generation 在 active 消失后尝试补写 → no_active，不会覆盖 retired 证据
    const late = recordGenerationTerminal(chestnutFs, expectedOf(record), {
      kind: 'unclean', detected_at: new Date().toISOString(), detected_by_pid: 999,
    });
    expect(late.kind).toBe('no_active');

    const retiredTerminalPath = path.join(
      chestnutDir, WATCHDOG_RETIRED_DIR, record.owner_token, WATCHDOG_TERMINAL_FILE);
    const retiredTerminal = JSON.parse(fs.readFileSync(retiredTerminalPath, 'utf-8'));
    expect(retiredTerminal.kind).toBe('stopped');
    expect(retiredTerminal.signal).toBe('SIGTERM');
  });

  it('overwrite fixture：不同 terminal 内容不会覆盖已存在的合法 terminal', () => {
    const record = seedActive();
    const first: WatchdogGenerationTerminal = {
      kind: 'crashed', reason: 'first crash', recorded_at: new Date().toISOString(),
    };
    expect(recordGenerationTerminal(chestnutFs, expectedOf(record), first).kind).toBe('recorded');

    const second: WatchdogGenerationTerminal = {
      kind: 'stopped', signal: 'SIGINT', recorded_at: new Date().toISOString(),
    };
    const result = recordGenerationTerminal(chestnutFs, expectedOf(record), second);
    expect(result.kind).toBe('already_recorded');
    if (result.kind === 'already_recorded') {
      expect(result.terminal.kind).toBe('crashed');
      expect(result.terminal.reason).toBe('first crash');
    }

    const read = inspectTerminal(chestnutFs);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.terminal.kind).toBe('crashed');
      expect(read.terminal.reason).toBe('first crash');
    }
  });
});
