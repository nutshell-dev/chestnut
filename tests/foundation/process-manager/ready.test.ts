/**
 * ready marker — isReady via generation active/ready.json (Phase 1204 Step E)
 *
 * 验证点：
 * 1. active + ready + l1IsAlive true → isReady true
 * 2. active + ready mismatch → isReady false + READY_MARK_STALE audit
 * 3. active + missing ready → isReady false
 * 4. corrupt ready.json → isReady false + GENERATION_MALFORMED audit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { writeActiveGenerationSync } from '../../helpers/generation-fixtures.js';

describe('isReady generation authority', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('ready-gen-');
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
    };
  }

  it('active + ready + alive → isReady true', () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    expect(isReady(ctx, daemonDir)).toBe(true);
  });

  it('missing active generation → isReady false', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'no-gen');

    expect(isReady(ctx, daemonDir)).toBe(false);
  });

  it('active + missing ready → isReady false', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'no-ready');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    // remove ready.json
    const readyPath = path.join(daemonDir, 'status', 'process', 'active', 'ready.json');
    fsSync.rmSync(readyPath);

    expect(isReady(ctx, daemonDir)).toBe(false);
  });

  it('stale ready (generation mismatch) → isReady false + READY_MARK_STALE audit', () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'stale-ready');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-active', pid: process.pid });
    // overwrite ready.json with different generation_id
    const readyPath = path.join(daemonDir, 'status', 'process', 'active', 'ready.json');
    fsSync.writeFileSync(
      readyPath,
      JSON.stringify({
        schema_version: 1,
        generation_id: 'gen-stale',
        pid: FAKE_LIVE_PID,
        created_at: new Date().toISOString(),
      }),
      'utf-8',
    );

    expect(isReady({ fs: nodeFs, audit, l1IsAlive: vi.fn().mockReturnValue(true) }, daemonDir)).toBe(false);

    const staleEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE);
    expect(staleEvents).toHaveLength(1);
  });

  it('corrupt ready.json → isReady false + GENERATION_MALFORMED audit', () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'corrupt-ready');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    const readyPath = path.join(daemonDir, 'status', 'process', 'active', 'ready.json');
    fsSync.writeFileSync(readyPath, 'not-json', 'utf-8');

    expect(isReady({ fs: nodeFs, audit, l1IsAlive: vi.fn().mockReturnValue(true) }, daemonDir)).toBe(false);

    const malformedEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED);
    expect(malformedEvents.length).toBeGreaterThanOrEqual(1);
  });
});
