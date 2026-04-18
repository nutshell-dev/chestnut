/**
 * watchdog-utils 测试 — clawHasContract + getClawActivityInfo (Phase 19) + Phase 18
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import {
  clawHasContract,
  getClawActivityInfo,
  gatherClawSnapshot,
  getEffectiveInterval,
  shouldResetNotifyCount,
} from '../../src/cli/commands/watchdog-utils.js';

let testDir: string;

beforeEach(() => {
  testDir = path.join(tmpdir(), `wdutils-${randomUUID()}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('clawHasContract', () => {
  it('returns false when no contract dirs exist', () => {
    expect(clawHasContract(testDir)).toBe(false);
  });

  it('returns true when contract/active has a subdirectory', () => {
    fs.mkdirSync(path.join(testDir, 'contract', 'active', 'contract-123'), { recursive: true });
    expect(clawHasContract(testDir)).toBe(true);
  });

  it('returns true when contract/paused has a subdirectory', () => {
    fs.mkdirSync(path.join(testDir, 'contract', 'paused', 'contract-456'), { recursive: true });
    expect(clawHasContract(testDir)).toBe(true);
  });

  it('returns false when contract/active exists but has no subdirectories (only files)', () => {
    fs.mkdirSync(path.join(testDir, 'contract', 'active'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'contract', 'active', 'somefile.json'), '{}');
    expect(clawHasContract(testDir)).toBe(false);
  });
});

describe('getClawActivityInfo', () => {
  function makeFsAudit(dir: string) {
    const clawFs = new NodeFileSystem({ baseDir: dir, enforcePermissions: false });
    const audit = new AuditWriter(clawFs, 'audit.tsv');
    return { clawFs, audit };
  }

  it('returns {null, null} when stream.jsonl is missing', async () => {
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastEventMs).toBeNull();
    expect(result.lastError).toBeNull();
  });

  it('updates lastEventMs for text_delta events', async () => {
    const ts = 1700000000000;
    fs.writeFileSync(
      path.join(testDir, 'stream.jsonl'),
      JSON.stringify({ type: 'text_delta', ts }) + '\n',
    );
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastEventMs).toBe(ts);
  });

  it('updates lastEventMs for thinking_delta and tool_call, picks latest', async () => {
    const ts1 = 1000;
    const ts2 = 2000;
    const lines = [
      JSON.stringify({ type: 'thinking_delta', ts: ts1 }),
      JSON.stringify({ type: 'tool_call', ts: ts2 }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastEventMs).toBe(ts2);
  });

  it('ignores llm_start events (not in LLM_OUTPUT_EVENTS) for lastEventMs', async () => {
    const ts = 1700000000000;
    fs.writeFileSync(
      path.join(testDir, 'stream.jsonl'),
      JSON.stringify({ type: 'llm_start', ts }) + '\n',
    );
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastEventMs).toBeNull();
  });

  it('sets lastError on turn_error, clears on subsequent turn_end', async () => {
    const lines = [
      JSON.stringify({ type: 'text_delta', ts: 1000 }),
      JSON.stringify({ type: 'turn_error', ts: 2000, error: 'timeout' }),
      JSON.stringify({ type: 'turn_end', ts: 3000 }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastError).toBeNull(); // turn_end cleared it
  });

  it('retains lastError when turn_error is the last terminal event', async () => {
    const lines = [
      JSON.stringify({ type: 'text_delta', ts: 1000 }),
      JSON.stringify({ type: 'turn_error', ts: 2000, error: 'crash' }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastError).toBe('crash');
  });

  it('turn_interrupted does not change lastError', async () => {
    const lines = [
      JSON.stringify({ type: 'turn_error', ts: 1000, error: 'some error' }),
      JSON.stringify({ type: 'turn_interrupted', ts: 2000 }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    // turn_interrupted neither sets nor clears — lastError stays from turn_error
    expect(result.lastError).toBe('some error');
  });

  // M1 fix: turn_interrupted updates lastEventMs (claw was active, just interrupted)
  it('turn_interrupted updates lastEventMs (counts as activity)', async () => {
    const lines = [
      JSON.stringify({ type: 'text_delta', ts: 1000 }),
      JSON.stringify({ type: 'turn_interrupted', ts: 2000 }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    // turn_interrupted should update lastEventMs — claw was running before interrupt
    expect(result.lastEventMs).toBe(2000);
  });

  // M1 fix: only turn_interrupted (no LLM output) still counts as activity
  it('turn_interrupted alone updates lastEventMs', async () => {
    const lines = [
      JSON.stringify({ type: 'turn_interrupted', ts: 1500 }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastEventMs).toBe(1500);
  });

  it('returns {null, null} for empty stream.jsonl', async () => {
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), '');
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastEventMs).toBeNull();
    expect(result.lastError).toBeNull();
  });
});

// Phase 18 tests

const fakePm = (alive: boolean) => ({ isAlive: () => alive });

describe('gatherClawSnapshot', () => {
  it('status=running when pm.isAlive=true', () => {
    const snap = gatherClawSnapshot(testDir, fakePm(true), 'c1');
    expect(snap.status).toBe('running');
  });

  it('status=stopped when pm.isAlive=false', () => {
    const snap = gatherClawSnapshot(testDir, fakePm(false), 'c1');
    expect(snap.status).toBe('stopped');
  });

  it('contract=active:<id> when active dir has a subdirectory', () => {
    fs.mkdirSync(path.join(testDir, 'contract', 'active', 'ctr-abc'), { recursive: true });
    const snap = gatherClawSnapshot(testDir, fakePm(false), 'c1');
    expect(snap.contract).toBe('active:ctr-abc');
  });

  it('contract=paused:<id> when paused dir has a subdirectory', () => {
    fs.mkdirSync(path.join(testDir, 'contract', 'paused', 'ctr-def'), { recursive: true });
    const snap = gatherClawSnapshot(testDir, fakePm(false), 'c1');
    expect(snap.contract).toBe('paused:ctr-def');
  });

  it('contract=none when no contract dirs exist', () => {
    const snap = gatherClawSnapshot(testDir, fakePm(false), 'c1');
    expect(snap.contract).toBe('none');
  });

  it('inboxPending counts .md files in inbox/pending (ignores other extensions)', () => {
    const inboxDir = path.join(testDir, 'inbox', 'pending');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'msg1.md'), '');
    fs.writeFileSync(path.join(inboxDir, 'msg2.md'), '');
    fs.writeFileSync(path.join(inboxDir, 'ignore.txt'), '');
    const snap = gatherClawSnapshot(testDir, fakePm(false), 'c1');
    expect(snap.inboxPending).toBe(2);
  });

  it('outboxPending counts .md files in outbox/pending', () => {
    const outboxDir = path.join(testDir, 'outbox', 'pending');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'out1.md'), '');
    const snap = gatherClawSnapshot(testDir, fakePm(false), 'c1');
    expect(snap.outboxPending).toBe(1);
  });
});

describe('getEffectiveInterval', () => {
  it('returns 1x timeoutMs for notifyCount=0', () => {
    expect(getEffectiveInterval(0, 300000)).toBe(300000);
  });

  it('returns 1x timeoutMs for notifyCount=1', () => {
    expect(getEffectiveInterval(1, 300000)).toBe(300000);
  });

  it('returns 3x timeoutMs for notifyCount=2 (backoff threshold)', () => {
    expect(getEffectiveInterval(2, 300000)).toBe(900000);
  });

  it('returns 3x timeoutMs for notifyCount=5', () => {
    expect(getEffectiveInterval(5, 300000)).toBe(900000);
  });
});

describe('shouldResetNotifyCount', () => {
  it('returns false when lastEventMs is null', () => {
    expect(shouldResetNotifyCount(null, 0)).toBe(false);
  });

  it('returns true when lastEventMs > lastNotified (new activity since notification)', () => {
    // Event at 1500, last notified at 1000 → 1500 > 1000 → reset
    expect(shouldResetNotifyCount(1500, 1000)).toBe(true);
  });

  it('returns false when lastEventMs <= lastNotified (no new activity)', () => {
    // Event at 1000, last notified at 1000 → 1000 <= 1000 → no reset
    expect(shouldResetNotifyCount(1000, 1000)).toBe(false);
    // Event at 500, last notified at 1000 → 500 <= 1000 → no reset
    expect(shouldResetNotifyCount(500, 1000)).toBe(false);
  });
});
