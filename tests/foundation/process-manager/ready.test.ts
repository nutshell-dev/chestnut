/**
 * readiness — typed owner via generation active/ready.json (Phase 1204 Step E, phase 1771 typed 化)
 *
 * 验证点：
 * 1. active + ready + l1IsAlive true → readiness{kind:'ready',generationId,pid}；isReady convenience true
 * 2. active + ready mismatch → not_ready{stale_generation} + READY_MARK_STALE audit
 * 3. missing active → not_ready{missing_active}；missing ready → not_ready{missing_ready}
 * 4. corrupt ready.json / generation.json → malformed{file,error} + GENERATION_MALFORMED audit
 * 5. 非 ENOENT 读失败 → read_failure{file,error}（不得压平为 malformed 或 not_ready）
 * 6. l1IsAlive 抛错 → probe_unavailable{error} + READY_CHECK_ISALIVE_THROW audit；
 *    l1IsAlive false → not_ready{process_not_alive}
 * 7. isReady convenience 仅 kind==='ready'，fail-closed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { readiness, isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { writeActiveGenerationSync } from '../../helpers/generation-fixtures.js';

describe('readiness typed owner', () => {
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

  function makeCtx(overrides?: Partial<ProcessManagerContext>): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      l1IsAlive: vi.fn().mockReturnValue(true),
      ...overrides,
    };
  }

  /** 包装真实 fs：指定文件名（ basename ）readSync 抛非 ENOENT 错误，模拟权限/IO 故障。 */
  function fsWithReadFailure(failingFile: string): FileSystem {
    const wrapper = Object.create(nodeFs) as NodeFileSystem;
    wrapper.readSync = (p: string): string => {
      if (p.endsWith(failingFile)) {
        const err = new Error(`EACCES: permission denied, read '${p}'`) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return nodeFs.readSync(p);
    };
    return wrapper as unknown as FileSystem;
  }

  it('active + ready + alive → readiness ready{generationId,pid}；isReady convenience true', () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    const daemonDir = testClawDaemonDir(tempDir, clawId);
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    const result = readiness(ctx, daemonDir);
    expect(result).toEqual({ kind: 'ready', generationId: 'gen-1', pid: process.pid });
    expect(isReady(ctx, daemonDir)).toBe(true);
  });

  it('missing active generation → not_ready{missing_active}；isReady false', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'no-gen');

    expect(readiness(ctx, daemonDir)).toEqual({ kind: 'not_ready', reason: 'missing_active' });
    expect(isReady(ctx, daemonDir)).toBe(false);
  });

  it('active + missing ready → not_ready{missing_ready}；isReady false', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'no-ready');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    // remove ready.json
    const readyPath = path.join(daemonDir, 'status', 'process', 'active', 'ready.json');
    fsSync.rmSync(readyPath);

    expect(readiness(ctx, daemonDir)).toEqual({ kind: 'not_ready', reason: 'missing_ready' });
    expect(isReady(ctx, daemonDir)).toBe(false);
  });

  it('stale ready (generation mismatch) → not_ready{stale_generation} + READY_MARK_STALE audit', () => {
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

    const result = readiness({ fs: nodeFs, audit, l1IsAlive: vi.fn().mockReturnValue(true) }, daemonDir);
    expect(result).toEqual({ kind: 'not_ready', reason: 'stale_generation' });

    const staleEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE);
    expect(staleEvents).toHaveLength(1);
  });

  it('corrupt ready.json → malformed{file:ready.json} + GENERATION_MALFORMED audit', () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'corrupt-ready');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    const readyPath = path.join(daemonDir, 'status', 'process', 'active', 'ready.json');
    fsSync.writeFileSync(readyPath, 'not-json', 'utf-8');

    const result = readiness({ fs: nodeFs, audit, l1IsAlive: vi.fn().mockReturnValue(true) }, daemonDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.file).toBe('ready.json');
      expect(result.error).toBeDefined();
    }

    const malformedEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED);
    expect(malformedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('corrupt active generation.json → malformed{file:generation.json} + GENERATION_MALFORMED audit', () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'corrupt-gen');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    const genPath = path.join(daemonDir, 'status', 'process', 'active', 'generation.json');
    fsSync.writeFileSync(genPath, '{"schema_version":1,', 'utf-8');

    const result = readiness({ fs: nodeFs, audit, l1IsAlive: vi.fn().mockReturnValue(true) }, daemonDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.file).toBe('generation.json');
      expect(result.error).toBeDefined();
    }

    const malformedEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED);
    expect(malformedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('ready.json 非 ENOENT 读失败 → read_failure{file:ready.json}（保留原始 error，不压平）', () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'read-fail-ready');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    const result = readiness(
      { fs: fsWithReadFailure('ready.json'), audit, l1IsAlive: vi.fn().mockReturnValue(true) },
      daemonDir,
    );
    expect(result.kind).toBe('read_failure');
    if (result.kind === 'read_failure') {
      expect(result.file).toBe('ready.json');
      expect((result.error as NodeJS.ErrnoException).code).toBe('EACCES');
    }
    expect(isReady({ fs: fsWithReadFailure('ready.json'), audit, l1IsAlive: vi.fn().mockReturnValue(true) }, daemonDir)).toBe(false);

    // read 失败同属 fail-closed 故障：仍写 GENERATION_MALFORMED audit 以便排查
    const malformedEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED);
    expect(malformedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('generation.json 非 ENOENT 读失败 → read_failure{file:generation.json}', () => {
    const { audit } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'read-fail-gen');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    const result = readiness(
      { fs: fsWithReadFailure('generation.json'), audit, l1IsAlive: vi.fn().mockReturnValue(true) },
      daemonDir,
    );
    expect(result.kind).toBe('read_failure');
    if (result.kind === 'read_failure') {
      expect(result.file).toBe('generation.json');
      expect((result.error as NodeJS.ErrnoException).code).toBe('EACCES');
    }
  });

  it('l1IsAlive 抛错 → probe_unavailable{error} + READY_CHECK_ISALIVE_THROW audit；isReady false', () => {
    const { audit, events } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'probe-throw');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    const probeErr = new Error('EPERM: probe unavailable');
    const l1IsAlive = vi.fn().mockImplementation(() => {
      throw probeErr;
    });

    const ctx = { fs: nodeFs, audit, l1IsAlive };
    const result = readiness(ctx, daemonDir);
    expect(result).toEqual({ kind: 'probe_unavailable', error: probeErr });
    expect(isReady(ctx, daemonDir)).toBe(false);

    // readiness 与 isReady 各 probe 一次，各写一条事实；只要求至少一条、不误绑数量
    const throwEvents = events.filter((e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW);
    expect(throwEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('l1IsAlive false → not_ready{process_not_alive}；isReady false', () => {
    const ctx = makeCtx({ l1IsAlive: vi.fn().mockReturnValue(false) });
    const daemonDir = testClawDaemonDir(tempDir, 'not-alive');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    expect(readiness(ctx, daemonDir)).toEqual({ kind: 'not_ready', reason: 'process_not_alive' });
    expect(isReady(ctx, daemonDir)).toBe(false);
  });
});
