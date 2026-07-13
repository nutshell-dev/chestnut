/**
 * phase 517 B1 regression:
 * healthCommand must not crash when the claw has been init'd but never started
 * (i.e., inbox/outbox/contract dirs don't exist yet).
 *
 * Root cause: FileSystem wrapper throws FileNotFoundError (code='FS_NOT_FOUND')
 * but the narrow `if (err.code !== 'ENOENT') throw err` rethrows because
 * 'FS_NOT_FOUND' !== 'ENOENT'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

const { healthCommand } = await import('../../src/cli/commands/claw.js');

function makeTempRootWithClawConfig(): { root: string; clawName: string } {
  const root = path.join(tmpdir(), `chestnut-health-test-${randomUUID()}`);
  fs.mkdirSync(path.join(root, '.chestnut'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.chestnut', 'config.yaml'),
    'llm:\n  primary:\n    api_key: test\n    preset: anthropic\n    model: claude-sonnet-4-5\n  retry_attempts: 1\n  retry_delay_ms: 100\n',
  );

  // Create claw config dir + config.yaml ONLY (no inbox/outbox/contract dirs)
  const clawName = 'test-claw';
  const clawDir = path.join(root, '.chestnut', 'claws', clawName);
  fs.mkdirSync(clawDir, { recursive: true });
  fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: test-claw\n');

  return { root, clawName };
}

describe('healthCommand on stopped claw without runtime dirs', () => {
  let root: string;
  let clawName: string;
  let prevRoot: string | undefined;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    ({ root, clawName } = makeTempRootWithClawConfig());
    prevRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = root;
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = prevRoot;
    console.log = origLog;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not crash when inbox/outbox/contract dirs do not exist', async () => {
    // phase 517 B1: pre-fix this throws because clawFs.listSync throws
    // FileNotFoundError with code='FS_NOT_FOUND' which doesn't match 'ENOENT'.
    await expect(healthCommand({ fsFactory }, clawName, { json: true })).resolves.not.toThrow();
    const jsonLine = logs.find(l => l.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const payload = JSON.parse(jsonLine!);
    expect(payload.inbox_pending).toBe(0);
    expect(payload.outbox_pending).toBe(0);
    expect(payload.contract).toBe('none');
  });
});
