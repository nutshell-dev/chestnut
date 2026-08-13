/**
 * phase 1386: `claw <id> wakeup` CLI 测试（schedule / list / cancel + 时长解析）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { wakeupCommand, parseDurationMs } from '../../src/cli/commands/claw-wakeup.js';
import { CliError } from '../../src/cli/errors.js';
import { listWakeups } from '../../src/foundation/messaging/index.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('parseDurationMs', () => {
  it('parses simple units', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('parses compound durations like 1h30m', () => {
    expect(parseDurationMs('1h30m')).toBe(90 * 60_000);
  });

  it('tolerates whitespace between segments', () => {
    expect(parseDurationMs('1h 30m')).toBe(90 * 60_000);
  });

  it('throws for invalid input', () => {
    expect(() => parseDurationMs('abc')).toThrow(CliError);
    expect(() => parseDurationMs('0s')).toThrow(CliError);
    expect(() => parseDurationMs('5x')).toThrow(CliError);
  });
});

describe('claw wakeup command', () => {
  let tmpRoot: string;
  let chestnutRoot: string;
  let clawDir: string;
  let deps: FakeClawCommandDeps;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let prevRoot: string | undefined;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(tmpdir(), `claw-wakeup-${randomUUID()}`);
    chestnutRoot = path.join(tmpRoot, '.chestnut');
    clawDir = path.join(chestnutRoot, 'claws', 'alice');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: alice\n');
    prevRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpRoot;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    deps = makeClawCommandDeps(fsFactory);
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = prevRoot;
    logSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('schedules a future wakeup with --in and persists it', async () => {
    const before = Date.now();
    await wakeupCommand(deps, 'alice', {
      subcommand: 'schedule',
      message: 'check the site',
      inDuration: '24h',
    });
    const after = Date.now();

    const nfs = fsFactory(chestnutRoot);
    const records = listWakeups(nfs, path.join('claws', 'alice'));
    expect(records).toHaveLength(1);
    expect(records[0].message).toBe('check the site');
    const deliverAtMs = Date.parse(records[0].deliverAt);
    expect(deliverAtMs).toBeGreaterThanOrEqual(before + 86_400_000 - 1000);
    expect(deliverAtMs).toBeLessThanOrEqual(after + 86_400_000 + 1000);
    const logged = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/scheduled for/);
  });

  it('schedules with --at ISO time', async () => {
    const iso = '2026-08-14T12:00:00.000Z';
    await wakeupCommand(deps, 'alice', {
      subcommand: 'schedule',
      message: 'standup',
      atIso: iso,
    });
    const nfs = fsFactory(chestnutRoot);
    const records = listWakeups(nfs, path.join('claws', 'alice'));
    expect(records[0].deliverAt).toBe(iso);
  });

  it('reports immediate when deliverAt is in the past', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await wakeupCommand(deps, 'alice', {
      subcommand: 'schedule',
      message: 'late',
      atIso: past,
    });
    // immediate mode does not persist
    const nfs = fsFactory(chestnutRoot);
    expect(listWakeups(nfs, path.join('claws', 'alice'))).toHaveLength(0);
    const logged = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/due now/);
  });

  it('rejects empty message', async () => {
    await expect(wakeupCommand(deps, 'alice', {
      subcommand: 'schedule', message: '   ', inDuration: '5m',
    })).rejects.toThrow(/must not be empty/);
  });

  it('rejects invalid --at ISO', async () => {
    await expect(wakeupCommand(deps, 'alice', {
      subcommand: 'schedule', message: 'x', atIso: 'nope',
    })).rejects.toThrow(/Invalid --at/);
  });

  it('throws when claw does not exist', async () => {
    const ghostDeps = makeClawCommandDeps(fsFactory, {
      loadClaw: (() => undefined) as FakeClawCommandDeps['rootConfig']['loadClaw'],
    });
    await expect(wakeupCommand(ghostDeps, 'ghost', {
      subcommand: 'list', json: false,
    })).rejects.toThrow(/does not exist/);
  });

  it('lists scheduled wakeups and prints empty state', async () => {
    await wakeupCommand(deps, 'alice', { subcommand: 'list', json: false });
    const logged = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/No wakeups scheduled/);
  });

  it('lists as JSON when --json', async () => {
    await wakeupCommand(deps, 'alice', {
      subcommand: 'schedule', message: 'json-case', inDuration: '1h',
    });
    logSpy.mockClear();
    await wakeupCommand(deps, 'alice', { subcommand: 'list', json: true });
    const out = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].message).toBe('json-case');
  });

  it('cancels a scheduled wakeup', async () => {
    const nfs = fsFactory(chestnutRoot);
    const { scheduleWakeup: schedule } = await import('../../src/foundation/messaging/index.js');
    const { record } = schedule(
      nfs,
      path.join('claws', 'alice'),
      'alice',
      new Date(Date.now() + 60_000).toISOString(),
      'to cancel',
      { write: () => {} } as any,
    );
    logSpy.mockClear();
    await wakeupCommand(deps, 'alice', { subcommand: 'cancel', wakeupId: record.id });
    expect(listWakeups(nfs, path.join('claws', 'alice'))).toHaveLength(0);
    const logged = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toMatch(/cancelled/);
  });

  it('cancel of unknown id throws CliError', async () => {
    await expect(wakeupCommand(deps, 'alice', {
      subcommand: 'cancel', wakeupId: 'nope',
    })).rejects.toThrow(/not found/);
  });
});
