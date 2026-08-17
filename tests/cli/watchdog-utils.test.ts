/**
 * watchdog-utils 测试 — getClawActivityInfo only (Phase 1396 Step H).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import * as streamModule from '../../src/foundation/stream/index.js';
import { getClawActivityInfo } from '../../src/watchdog/watchdog-utils.js';

let testDir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  testDir = path.join(tmpdir(), `wdutils-${randomUUID()}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function makeFsAudit(dir: string) {
  const clawFs = new NodeFileSystem({ baseDir: dir });
  const audit = new AuditWriter(clawFs, 'audit.tsv');
  return { clawFs, audit };
}

describe('getClawActivityInfo', () => {
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

  it('handles non-string error field defensively (Error object)', async () => {
    const errObj = new Error('mock err');
    const readAllSpy = vi.spyOn(streamModule, 'readAll').mockResolvedValue([
      { type: 'turn_error', ts: 2000, error: errObj } as any,
    ]);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    readAllSpy.mockRestore();
    // String(Error) → 'Error: mock err' / 至少是个 string，不是 Error 实例
    expect(typeof result.lastError).toBe('string');
    expect(result.lastError).toContain('mock err');
  });

  it('falls back to "unknown error" for null event.error', async () => {
    const lines = [
      JSON.stringify({ type: 'turn_error', ts: 2000, error: null }),
    ].join('\n');
    fs.writeFileSync(path.join(testDir, 'stream.jsonl'), lines);
    const { clawFs, audit } = makeFsAudit(testDir);
    const result = await getClawActivityInfo(clawFs, audit);
    expect(result.lastError).toBe('unknown error');
  });
});
