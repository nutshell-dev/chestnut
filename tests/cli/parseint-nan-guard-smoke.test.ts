/**
 * Layer B CLI integration smoke test — Layer B canary.
 * Layer A (parseIntOption validation) tested by parseint-nan-guard.test.ts.
 *
 * Verifies:
 * - npx tsx src/cli/index.ts boots
 * - commander parses --limit + dispatches to outboxCommand
 * - successful exec exits with code 0
 * - parseIntOption integration via helper to commander wiring works
 *
 * Single subprocess smoke test (no sister contention, predictable wall ~10-30s, 120000ms safety).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const CLI_ENTRY = path.resolve(process.cwd(), 'dist/cli.js');

// phase 1311 α-1: precondition fail-fast (mirror feedback_flaky_test_zero_tolerance / sister B.r1257 closed by phase 1257)
if (!fs.existsSync(CLI_ENTRY)) {
  throw new Error(
    `[phase1311-α-1] CLI_ENTRY missing: ${CLI_ENTRY} — run \`pnpm run build\` first. ` +
    `worktree-no-dist 根因 sister row B.r1257 closed by phase 1257 commit hook (run pnpm install hook trigger build)`,
  );
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_ENTRY, ...args], {
      env: {
        ...process.env,
        ...env,
        DEBUG: '*',                           // phase 1145 β: enable all debug namespaces
        NODE_OPTIONS: '--trace-warnings',     // phase 1145 β: surface unhandled rejections / warnings
      },
      cwd: process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      // phase 1145 β: unconditional dump on non-zero exit
      if (exitCode !== 0) {
        console.error('[phase1145-β] CLI subprocess exitCode:', exitCode);
        console.error('[phase1145-β] STDOUT (full):\n' + stdout);
        console.error('[phase1145-β] STDERR (full):\n' + stderr);
        // phase 1311 α-2: persist diagnostic to OS tmpdir (mirror phase 1307 α-2 模板)
        const dumpPath = path.join(
          tmpdir(),
          `phase1311-cli-smoke-fail-${process.pid}-${Date.now()}.json`,
        );
        try {
          fs.writeFileSync(dumpPath, JSON.stringify({
            args,
            envKeys: Object.keys(env),
            CLI_ENTRY,
            cliEntryExists: fs.existsSync(CLI_ENTRY),
            exitCode,
            stdout,
            stderr,
            cwd: process.cwd(),
            timestamp: new Date().toISOString(),
          }, null, 2));
          console.error(`[phase1311-α-2] diagnostic dump written to ${dumpPath}`);
        } catch (writeErr) {
          console.error(`[phase1311-α-2] failed to write diagnostic dump:`, writeErr);
        }
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function makeTempRoot(): string {
  const dir = path.join(tmpdir(), `phase915-smoke-${randomUUID()}`);
  fs.mkdirSync(path.join(dir, '.clawforum', 'claws', 'test-claw', 'outbox', 'pending'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.clawforum', 'config.yaml'),
    'llm:\n  primary:\n    api_key: test\n'
  );
  return dir;
}

describe('CLI smoke - parseInt NaN guard Layer B canary', () => {
  let root: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    root = makeTempRoot();
    prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = root;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('outbox --limit 10 → exit 0, no NaN error (Layer B integration canary)', async () => {
    const { stderr, exitCode } = await runCli(
      ['claw', 'outbox', 'test-claw', '--limit', '10'],
      { CLAWFORUM_ROOT: root }
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('--limit must be a non-negative integer');
  }, 120000);
});
