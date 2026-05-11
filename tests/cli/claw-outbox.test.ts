/**
 * Regression — outboxCommand must drain pending/*.md even for orphan claws
 * (directory exists but config.yaml is missing). The outbox scanner reports any
 * claw whose outbox/pending has messages, so the CLI must be able to drain
 * the same set; requiring config.yaml would leave motion unable to clear
 * orphan notifications except by hallucinating unrelated explanations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { outboxCommand } = await import('../../src/cli/commands/claw.js');

function makeTempRoot(): string {
  const dir = path.join(tmpdir(), `clawforum-outbox-cli-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.clawforum'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.clawforum', 'config.yaml'),
    'llm:\n  primary:\n    api_key: test\n'
  );
  return dir;
}

function seedPending(root: string, clawId: string, count: number): string {
  const pending = path.join(root, '.clawforum', 'claws', clawId, 'outbox', 'pending');
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
    prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = root;
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = prevRoot;
    console.log = origLog;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('drains orphan claw outbox (dir exists, no config.yaml)', async () => {
    const pending = seedPending(root, 'orphan-claw', 3);
    expect(fs.existsSync(path.join(root, '.clawforum', 'claws', 'orphan-claw', 'config.yaml'))).toBe(false);

    await outboxCommand('orphan-claw', { limit: 99 });

    const remaining = fs.readdirSync(pending).filter(f => f.endsWith('.md'));
    expect(remaining).toEqual([]);
    const done = fs.readdirSync(path.join(root, '.clawforum', 'claws', 'orphan-claw', 'outbox', 'done'));
    expect(done.filter(f => f.endsWith('.md'))).toHaveLength(3);
  });

  it('throws clear error when claw directory does not exist', async () => {
    await expect(outboxCommand('never-existed')).rejects.toThrow(/Claw directory not found/);
  });

  it('prints "outbox is empty" when pending dir missing but clawDir exists', async () => {
    fs.mkdirSync(path.join(root, '.clawforum', 'claws', 'claw-empty'), { recursive: true });

    await outboxCommand('claw-empty');

    expect(logs.some(l => l.includes('outbox is empty'))).toBe(true);
  });

  it('respects --limit and reports remaining count', async () => {
    seedPending(root, 'busy', 5);

    await outboxCommand('busy', { limit: 2 });

    expect(logs.some(l => l.includes('(3 more unread message(s))'))).toBe(true);
  });
});
