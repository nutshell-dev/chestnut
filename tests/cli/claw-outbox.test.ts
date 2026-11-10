/**
 * Regression — outboxCommand must drain pending/*.md even for orphan claws
 * (directory exists but config.yaml is missing). The outbox scanner reports any
 * claw whose outbox/pending has messages, so the CLI must be able to drain
 * the same set; requiring config.yaml would leave motion unable to clear
 * orphan notifications except by hallucinating unrelated explanations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const { outboxCommand } = await import('../../src/cli/commands/claw.js');

function makeTempRoot(): string {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const dir = path.join(tmpdir(), `chestnut-outbox-cli-test-${randomUUID()}`);
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
    fs.writeFileSync(path.join(pending, `msg${i}.md`), `message ${i}`);
  }
  return pending;
}

describe('outboxCommand', () => {
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

  it('drains orphan claw outbox (dir exists, no config.yaml)', async () => {
    const pending = seedPending(root, 'orphan-claw', 3);
    expect(fs.existsSync(path.join(root, '.chestnut', 'claws', 'orphan-claw', 'config.yaml'))).toBe(false);

    await outboxCommand({ fsFactory }, 'orphan-claw', { limit: 99 });

    const remaining = fs.readdirSync(pending).filter(f => f.endsWith('.md'));
    expect(remaining).toEqual([]);
    const done = fs.readdirSync(path.join(root, '.chestnut', 'claws', 'orphan-claw', 'outbox', 'done'));
    expect(done.filter(f => f.endsWith('.md'))).toHaveLength(3);
  });

  it('throws clear error when claw directory does not exist', async () => {
    await expect(outboxCommand({ fsFactory }, 'never-existed')).rejects.toThrow(/Claw directory not found/);
  });

  it('prints "outbox is empty" when pending dir missing but clawDir exists', async () => {
    fs.mkdirSync(path.join(root, '.chestnut', 'claws', 'claw-empty'), { recursive: true });

    await outboxCommand({ fsFactory }, 'claw-empty');

    expect(logs.some(l => l.includes('outbox is empty'))).toBe(true);
  });

  it('respects --limit and reports remaining count', async () => {
    seedPending(root, 'busy', 5);

    await outboxCommand({ fsFactory }, 'busy', { limit: 2 });

    expect(logs.some(l => l.includes('(3 more unread message(s))'))).toBe(true);
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

    await expect(outboxCommand({ fsFactory: failingFactory }, 'busy')).rejects.toMatchObject({
      code: 'CLAIM_OBSERVATION_PERSISTENCE_FAILED',
      cause: storageError,
    });

    expect(fs.readdirSync(pending).filter(f => f.endsWith('.md'))).toEqual(['msg0.md']);
    expect(fs.readFileSync(path.join(processing, claimName), 'utf8')).toBe('orphan content');
    expect(listMd(path.join(clawDir, 'outbox', 'done'))).toEqual([]);
    expect(logs.some(l => l.includes('outbox is empty'))).toBe(false);
  });
});

function listMd(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}
