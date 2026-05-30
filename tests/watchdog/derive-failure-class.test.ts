/**
 * phase 1482: deriveFailureClass + formatInactivityBody + clawHasActiveContract unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  deriveFailureClass,
  formatInactivityBody,
  clawHasActiveContract,
  clawHasContract,
} from '../../src/watchdog/watchdog-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeClawDir } from '../../src/foundation/identity/index.js';

describe('phase 1482: deriveFailureClass', () => {
  it('daemon dead → daemon_stopped (even if lastError exists)', () => {
    expect(deriveFailureClass({ daemonAlive: false, lastError: 'foo' })).toBe('daemon_stopped');
    expect(deriveFailureClass({ daemonAlive: false, lastError: null })).toBe('daemon_stopped');
    expect(deriveFailureClass({ daemonAlive: false, lastError: undefined })).toBe('daemon_stopped');
  });

  it('daemon alive + no lastError → daemon_silent', () => {
    expect(deriveFailureClass({ daemonAlive: true, lastError: undefined })).toBe('daemon_silent');
    expect(deriveFailureClass({ daemonAlive: true, lastError: null })).toBe('daemon_silent');
  });

  it('daemon alive + lastError → daemon_errored', () => {
    expect(deriveFailureClass({ daemonAlive: true, lastError: 'LLM timeout' })).toBe('daemon_errored');
  });
});

describe('phase 1482: formatInactivityBody', () => {
  const base = {
    clawId: 'clawA',
    inactiveMin: 30,
    notifyCount: 2,
    daemonStatus: 'stopped' as const,
    contract: 'active:c1',
    inboxPending: 0,
    outboxPending: 1,
  };

  it('daemon_stopped → "daemon stopped, last activity Nm ago"', () => {
    const body = formatInactivityBody({ ...base, failureClass: 'daemon_stopped' });
    expect(body).toMatch(/Claw clawA daemon stopped, last activity 30m ago/);
    expect(body).not.toMatch(/no progress/);
  });

  it('daemon_silent → "daemon running but no stream event for Nm"', () => {
    const body = formatInactivityBody({
      ...base,
      daemonStatus: 'running',
      failureClass: 'daemon_silent',
    });
    expect(body).toMatch(/daemon running but no stream event for 30m/);
  });

  it('daemon_errored → "daemon running with error Nm ago" + lastError suffix', () => {
    const body = formatInactivityBody({
      ...base,
      daemonStatus: 'running',
      failureClass: 'daemon_errored',
      lastError: 'LLM 503',
    });
    expect(body).toMatch(/daemon running with error 30m ago/);
    expect(body).toMatch(/last error: LLM 503/);
  });
});

describe('phase 1482: clawHasActiveContract vs clawHasContract', () => {
  let root: string;
  let fs: NodeFileSystem;
  const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

  beforeEach(async () => {
    root = path.join(tmpdir(), `wd-paused-skip-${randomUUID()}`);
    await fsAsync.mkdir(root, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('only paused/ subdir → clawHasContract true / clawHasActiveContract false', async () => {
    await fsAsync.mkdir(path.join(root, 'contract/paused/p1'), { recursive: true });
    const clawDir = makeClawDir(root);
    expect(clawHasContract(clawDir, fsFactory)).toBe(true);
    expect(clawHasActiveContract(clawDir, fsFactory)).toBe(false);
  });

  it('only active/ subdir → both true', async () => {
    await fsAsync.mkdir(path.join(root, 'contract/active/a1'), { recursive: true });
    const clawDir = makeClawDir(root);
    expect(clawHasContract(clawDir, fsFactory)).toBe(true);
    expect(clawHasActiveContract(clawDir, fsFactory)).toBe(true);
  });

  it('no contract dirs → both false', () => {
    const clawDir = makeClawDir(root);
    expect(clawHasContract(clawDir, fsFactory)).toBe(false);
    expect(clawHasActiveContract(clawDir, fsFactory)).toBe(false);
  });
});
