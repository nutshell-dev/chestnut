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

describe('phase 1482 + phase 2 reframe: deriveFailureClass (daemon_stopped 移除归 claw_crashed)', () => {
  it('daemon alive + no lastError → daemon_silent', () => {
    expect(deriveFailureClass({ daemonAlive: true, lastError: undefined })).toBe('daemon_silent');
    expect(deriveFailureClass({ daemonAlive: true, lastError: null })).toBe('daemon_silent');
  });

  it('daemon alive + lastError → daemon_errored', () => {
    expect(deriveFailureClass({ daemonAlive: true, lastError: 'LLM timeout' })).toBe('daemon_errored');
  });

  it('daemon dead 不再产 daemon_stopped (caller guard daemonAlive=true 上游 / 防御 fallback silent)', () => {
    // 此函数不再期望 daemon dead 输入；若漏 guard 仍传 false → 不抛、按 lastError 优先 fallback silent
    expect(deriveFailureClass({ daemonAlive: false, lastError: 'foo' })).toBe('daemon_errored');
    expect(deriveFailureClass({ daemonAlive: false, lastError: null })).toBe('daemon_silent');
  });
});

describe('phase 1482: formatInactivityBody', () => {
  const base = {
    clawId: 'clawA',
    inactiveMin: 30,
    /* notifyCount removed phase 4 1-shot */
    contract: 'active:c1',
  };

  it('phase 4 daemon_silent → clean self-contained sentence (no status/inbox/outbox 杂揉)', () => {
    const body = formatInactivityBody({ ...base, failureClass: 'daemon_silent' });
    expect(body).toBe(`Claw "clawA" daemon is running but has produced no events for 30m while in contract active:c1.`);
    expect(body).not.toMatch(/Status:|inbox_pending|outbox_pending/);
  });

  it('phase 4 daemon_errored → main sentence + Last error 单独段', () => {
    const body = formatInactivityBody({
      ...base,
      failureClass: 'daemon_errored',
      lastError: 'LLM 503',
    });
    expect(body).toContain('Claw "clawA" daemon is running but encountered an error 30m ago while in contract active:c1.');
    expect(body).toContain('\n\nLast error: LLM 503');
  });

  it('phase 4 daemon_errored without lastError → no "Last error:" section', () => {
    const body = formatInactivityBody({ ...base, failureClass: 'daemon_errored' });
    expect(body).not.toContain('Last error');
  });
});

describe('phase 1482: clawHasActiveContract vs clawHasContract', () => {
  let root: string;
  let fs: NodeFileSystem;
  const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `wd-paused-skip-${randomUUID()}`);
    await fsAsync.mkdir(root, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('only paused/ subdir → both false (legacy paused is not current)', async () => {
    await fsAsync.mkdir(path.join(root, 'contract/paused/p1'), { recursive: true });
    const clawDir = root;
    expect(clawHasContract(clawDir, fsFactory)).toBe(false);
    expect(clawHasActiveContract(clawDir, fsFactory)).toBe(false);
  });

  it('only active/ subdir → both true', async () => {
    await fsAsync.mkdir(path.join(root, 'contract/active/a1'), { recursive: true });
    const clawDir = root;
    expect(clawHasContract(clawDir, fsFactory)).toBe(true);
    expect(clawHasActiveContract(clawDir, fsFactory)).toBe(true);
  });

  it('no contract dirs → both false', () => {
    const clawDir = root;
    expect(clawHasContract(clawDir, fsFactory)).toBe(false);
    expect(clawHasActiveContract(clawDir, fsFactory)).toBe(false);
  });
});
