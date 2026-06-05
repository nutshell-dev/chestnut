/**
 * phase 2 γ4: deriveCrashClass + hasCleanStopMarker + formatCrashBody unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  deriveCrashClass,
  hasCleanStopMarker,
  formatCrashBody,
} from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeClawDir } from '../../src/foundation/paths.js';

describe('phase 2: deriveCrashClass', () => {
  it('no marker → active_unexpected', () => {
    expect(deriveCrashClass({ hasCleanStopMarker: false })).toBe('active_unexpected');
  });

  it('marker present → active_user_stopped', () => {
    expect(deriveCrashClass({ hasCleanStopMarker: true })).toBe('active_user_stopped');
  });
});

describe('phase 2: hasCleanStopMarker', () => {
  let root: string;
  const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

  beforeEach(async () => {
    root = path.join(tmpdir(), `wd-marker-${randomUUID()}`);
    await fsAsync.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('marker absent → false', () => {
    expect(hasCleanStopMarker(makeClawDir(root), fsFactory)).toBe(false);
  });

  it('marker present → true', async () => {
    await fsAsync.writeFile(path.join(root, 'clean-stop'), '');
    expect(hasCleanStopMarker(makeClawDir(root), fsFactory)).toBe(true);
  });

  it('claw dir missing → false (silent fallback)', () => {
    expect(hasCleanStopMarker(makeClawDir(path.join(tmpdir(), `non-existent-${randomUUID()}`)), fsFactory)).toBe(false);
  });

  it('marker read 后不删除 (read-only / 不消费)', async () => {
    await fsAsync.writeFile(path.join(root, 'clean-stop'), '');
    expect(hasCleanStopMarker(makeClawDir(root), fsFactory)).toBe(true);
    expect(hasCleanStopMarker(makeClawDir(root), fsFactory)).toBe(true);
    // marker 还在
    expect(await fsAsync.readFile(path.join(root, 'clean-stop'), 'utf-8')).toBe('');
  });
});

describe('phase 4: formatCrashBody (clean draft / self-contained per class / no raw audit events)', () => {
  const base = {
    clawId: 'clawA',
    contract: 'active:c1',
  };

  it('active_unexpected → "crashed unexpectedly while running contract" 句式', () => {
    const body = formatCrashBody({ ...base, crashClass: 'active_unexpected' });
    expect(body).toBe('Claw "clawA" crashed unexpectedly while running contract active:c1.');
    expect(body).not.toMatch(/process exited abnormally/);
    expect(body).not.toMatch(/last_events|outbox_pending/);
  });

  it('active_user_stopped → "stopped via CLI while running contract" 句式', () => {
    const body = formatCrashBody({ ...base, crashClass: 'active_user_stopped' });
    expect(body).toBe('Claw "clawA" was stopped via CLI while running contract active:c1.');
    expect(body).not.toMatch(/unexpectedly/);
  });
});
