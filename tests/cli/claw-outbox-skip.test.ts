/**
 * phase 1748 Step D — outboxSkipCommand behavior tests.
 *
 * Fixture pattern follows tests/cli/claw-outbox.test.ts (real fs + CHESTNUT_ROOT env
 * + console.log capture, direct command invocation). Skip semantics under test:
 * pending → done archive WITHOUT reading content, independent outbox_skipped audit
 * (never outbox_delivered).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { OutboxReader } from '../../src/foundation/messaging/outbox-reader.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const { outboxSkipCommand } = await import('../../src/cli/commands/claw.js');

function makeTempRoot(): string {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const dir = path.join(tmpdir(), `chestnut-outbox-skip-cli-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.chestnut'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.chestnut', 'config.yaml'),
    'llm:\n  primary:\n    api_key: test\n'
  );
  return dir;
}

function seedPending(root: string, clawId: string, count: number): string {
  const pending = path.join(root, '.chestnut', 'claws', clawId, 'outbox', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(pending, `msg${i}.md`), `SECRET-CONTENT-${i}`);
  }
  return pending;
}

function listMd(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}

/** Minimal AuditLog spy recording write(event, ...cols) calls. */
function makeAuditSpy() {
  const calls: { event: string; cols: string[] }[] = [];
  const audit = {
    write: vi.fn((event: string, ...cols: string[]) => { calls.push({ event, cols }); }),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  } as unknown as AuditLog;
  return { audit, calls };
}

describe('outboxSkipCommand', () => {
  let root: string;
  let prevRoot: string | undefined;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    root = makeTempRoot();
    prevRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = root;
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = prevRoot;
    console.log = origLog;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('skips pending messages to done/ without printing content', async () => {
    const pending = seedPending(root, 'busy', 3);

    await outboxSkipCommand({ fsFactory }, 'busy', { limit: 99 });

    expect(listMd(pending)).toEqual([]);
    const done = path.join(root, '.chestnut', 'claws', 'busy', 'outbox', 'done');
    expect(listMd(done)).toHaveLength(3);

    // filenames printed, message body never leaked
    expect(logs.filter(l => l.startsWith('- '))).toHaveLength(3);
    expect(logs.some(l => l.includes('skipped 3 message(s) (0 remaining)'))).toBe(true);
    expect(logs.some(l => l.includes('SECRET-CONTENT'))).toBe(false);
  });

  it('emits skip audit events and never outbox_delivered', async () => {
    seedPending(root, 'busy', 2);
    const { audit, calls } = makeAuditSpy();

    await outboxSkipCommand({ fsFactory }, 'busy', { limit: 99 }, { audit });

    const events = calls.map(c => c.event);
    expect(events).toContain('cli_claw_outbox_skip_start');
    expect(events).toContain('cli_claw_outbox_skip_done');
    expect(events.filter(e => e === 'outbox_skipped')).toHaveLength(2);
    expect(events).not.toContain('outbox_delivered');

    const done = calls.find(c => c.event === 'cli_claw_outbox_skip_done');
    expect(done?.cols).toContain('count=2');
    expect(done?.cols).toContain('remaining=0');
  });

  it('respects --limit and reports remaining count', async () => {
    const pending = seedPending(root, 'busy', 3);

    await outboxSkipCommand({ fsFactory }, 'busy', { limit: 2 });

    expect(listMd(pending)).toHaveLength(1);
    expect(logs.some(l => l.includes('skipped 2 message(s) (1 remaining)'))).toBe(true);
  });

  it('--all clears all pending messages', async () => {
    const pending = seedPending(root, 'busy', 5);

    await outboxSkipCommand({ fsFactory }, 'busy', { all: true });

    expect(listMd(pending)).toEqual([]);
    expect(logs.some(l => l.includes('skipped 5 message(s) (0 remaining)'))).toBe(true);
  });

  it('prints "outbox is empty" when pending dir missing but clawDir exists', async () => {
    fs.mkdirSync(path.join(root, '.chestnut', 'claws', 'claw-empty'), { recursive: true });

    await outboxSkipCommand({ fsFactory }, 'claw-empty');

    expect(logs.some(l => l.includes('outbox is empty'))).toBe(true);
  });

  it('skips orphan claw outbox (dir exists, no config.yaml)', async () => {
    const pending = seedPending(root, 'orphan-claw', 3);
    expect(fs.existsSync(path.join(root, '.chestnut', 'claws', 'orphan-claw', 'config.yaml'))).toBe(false);

    await outboxSkipCommand({ fsFactory }, 'orphan-claw', { limit: 99 });

    expect(listMd(pending)).toEqual([]);
    const done = path.join(root, '.chestnut', 'claws', 'orphan-claw', 'outbox', 'done');
    expect(listMd(done)).toHaveLength(3);
  });

  it('throws clear error when claw directory does not exist', async () => {
    await expect(outboxSkipCommand({ fsFactory }, 'never-existed')).rejects.toThrow(/Claw directory not found/);
  });

  it('rejects observation persistence failure before claiming or reporting empty', async () => {
    const pending = seedPending(root, 'busy', 1);
    const clawDir = path.join(root, '.chestnut', 'claws', 'busy');
    const processing = path.join(clawDir, 'outbox', 'processing');
    fs.mkdirSync(processing, { recursive: true });
    const startTimeHex = Buffer.from('Mon Jan 01 00:00:00 2020').toString('hex');
    const claimName = `cli_${process.pid}_${startTimeHex}_abc123_orphan.md`;
    fs.writeFileSync(path.join(processing, claimName), 'orphan content');
    const storageError = new Error('observation storage unavailable');
    const failingFactory = (dir: string) => {
      const real = new NodeFileSystem({ baseDir: dir });
      const writeAtomic = real.writeAtomic.bind(real);
      vi.spyOn(real, 'writeAtomic').mockImplementation(async (targetPath, content) => {
        if (targetPath.includes('processing-observations') && content.includes('"event":"process_observed"')) {
          throw storageError;
        }
        return writeAtomic(targetPath, content);
      });
      return real;
    };

    await expect(outboxSkipCommand({ fsFactory: failingFactory }, 'busy')).rejects.toMatchObject({
      code: 'CLAIM_OBSERVATION_PERSISTENCE_FAILED',
      cause: storageError,
    });

    expect(listMd(pending)).toEqual(['msg0.md']);
    expect(fs.readFileSync(path.join(processing, claimName), 'utf8')).toBe('orphan content');
    expect(listMd(path.join(clawDir, 'outbox', 'done'))).toEqual([]);
    expect(logs.some(l => l.includes('outbox is empty'))).toBe(false);
  });

  it('rejects an unavailable mclaim_ record during init before claimNext or empty output', async () => {
    const pending = seedPending(root, 'busy', 1);
    const clawDir = path.join(root, '.chestnut', 'claws', 'busy');
    const processing = path.join(clawDir, 'outbox', 'processing');
    fs.mkdirSync(processing, { recursive: true });
    const claimName = 'mclaim_1_123e4567-e89b-42d3-a456-426614174000.md';
    fs.writeFileSync(path.join(processing, claimName), 'orphan content');
    const claimNext = vi.spyOn(OutboxReader.prototype, 'claimNext');

    await expect(outboxSkipCommand({ fsFactory }, 'busy')).rejects.toMatchObject({
      code: 'CLAIM_RECORD_UNAVAILABLE',
      entry: claimName,
      issue: { kind: 'missing' },
    });

    expect(claimNext).not.toHaveBeenCalled();
    expect(listMd(pending)).toEqual(['msg0.md']);
    expect(fs.readFileSync(path.join(processing, claimName), 'utf8')).toBe('orphan content');
    expect(listMd(path.join(clawDir, 'outbox', 'done'))).toEqual([]);
    expect(logs.some(l => l.includes('outbox is empty'))).toBe(false);
  });
});
