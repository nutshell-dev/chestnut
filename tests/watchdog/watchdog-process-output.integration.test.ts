/** Phase 2153 Step B1：真实 detached child 的 combined raw stdout/stderr 证据。 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { spawnDetached } from '../../src/foundation/process-exec/index.js';
import { _resetWatchdogContextForTest } from '../../src/watchdog/watchdog-context.js';
import { prepareWatchdogProcessOutput } from '../../src/watchdog/watchdog-log.js';

const fsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });
const RAW_OUTPUT_WAIT_BUDGET_MS = 10_000;
const RAW_OUTPUT_POLL_INTERVAL_MS = 20;
const originalRoot = process.env.CHESTNUT_ROOT;
let tmpDir: string;

async function waitForRawOutput(outputPath: string): Promise<string> {
  const deadline = Date.now() + RAW_OUTPUT_WAIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf8');
      if (
        content.includes('watchdog-raw-stdout')
        && content.includes('watchdog-raw-stderr')
        && content.includes('watchdog-raw-uncaught')
      ) {
        return content;
      }
    }
    await delay(RAW_OUTPUT_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for raw watchdog output at ${outputPath}`);
}

beforeEach(() => {
  _resetWatchdogContextForTest();
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-real-output-${randomUUID()}`);
  process.env.CHESTNUT_ROOT = tmpDir;
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('watchdog raw process output', () => {
  it('真实 child 的 stdout、stderr、uncaught crash 按 combined stream 顺序落同一文件', async () => {
    const outputPath = prepareWatchdogProcessOutput(fsFactory);
    const fixture = path.join(__dirname, 'fixtures', 'raw-output-crash-child.mjs');

    const outcome = await spawnDetached(process.execPath, [fixture], {
      cwd: tmpDir,
      logFile: outputPath,
    });
    expect(outcome.kind).toBe('spawned');

    const raw = await waitForRawOutput(outputPath);
    const stdoutAt = raw.indexOf('watchdog-raw-stdout');
    const stderrAt = raw.indexOf('watchdog-raw-stderr');
    const crashAt = raw.indexOf('watchdog-raw-uncaught');
    expect(stdoutAt).toBeGreaterThanOrEqual(0);
    expect(stderrAt).toBeGreaterThan(stdoutAt);
    expect(crashAt).toBeGreaterThan(stderrAt);
  });
});
