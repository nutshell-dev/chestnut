/**
 * liveness — typed owner via generation active/{generation,pid}.json（phase 1773 typed 化）
 *
 * 验证点：
 * 1. active + pid + l1IsAlive true → liveness{kind:'alive',pid}；pid record start_time 透传
 * 2. l1IsAlive false → dead{pid}；l1IsAlive 抛 ESRCH → dead{pid}（pid 消失 = 死亡终局）
 * 3. l1IsAlive 抛非 ESRCH（EPERM/未知）→ probe_unavailable{pid,error}，error identity 保留
 *    （phase 1773 probe 异常不伪装 alive，由 caller 显式决策）
 * 4. missing active → absent{missing_active}；active 无 pid.json → absent{missing_pid}
 * 5. corrupt generation.json / pid.json → malformed{file}（evidence 保留）
 * 6. pid generation_id 与 active 不匹配 → malformed{file:'pid.json', evidence:'pid_generation_mismatch'}
 * 7. 非 ENOENT 读失败（generation.json）→ malformed{file:'generation.json'}，cause identity 保留
 * 8. describeLiveness 各 kind 渲染快照（纯渲染投影，决策必须走 discriminant）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { liveness, describeLiveness } from '../../../src/foundation/process-manager/alive.js';
import { makeAudit } from '../../helpers/audit.js';
import { formatErr } from '../../../src/foundation/node-utils/index.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { writeActiveGenerationSync } from '../../helpers/generation-fixtures.js';
import {
  aliveLiveness,
  deadLiveness,
  absentLiveness,
  malformedLiveness,
  probeUnavailableLiveness,
} from '../../helpers/liveness-fixtures.js';

describe('liveness typed owner', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTrackedTempDir('liveness-gen-');
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

  it('active + pid + alive → alive{pid}；pid record start_time 透传', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'live-claw');
    const startTime = 'Fri May 30 13:00:00 2026';
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid, startTime });

    const result = liveness(ctx, daemonDir);
    expect(result).toEqual({ kind: 'alive', pid: process.pid, startTime });
  });

  it('active + pid 无 start_time → alive{pid} 无 startTime 字段', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'live-no-start');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    expect(liveness(ctx, daemonDir)).toEqual({ kind: 'alive', pid: process.pid });
  });

  it('l1IsAlive false → dead{pid}', () => {
    const ctx = makeCtx({ l1IsAlive: vi.fn().mockReturnValue(false) });
    const daemonDir = testClawDaemonDir(tempDir, 'dead-claw');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    expect(liveness(ctx, daemonDir)).toEqual({ kind: 'dead', pid: process.pid });
  });

  it('l1IsAlive 抛 ESRCH → dead{pid}（pid 已消失 = 死亡终局）', () => {
    const daemonDir = testClawDaemonDir(tempDir, 'esrch-claw');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    const probeErr = new Error('No such process') as NodeJS.ErrnoException;
    probeErr.code = 'ESRCH';
    const ctx = makeCtx({
      l1IsAlive: vi.fn().mockImplementation(() => {
        throw probeErr;
      }),
    });

    expect(liveness(ctx, daemonDir)).toEqual({ kind: 'dead', pid: process.pid });
  });

  it('l1IsAlive 抛 EPERM → probe_unavailable{pid,error}（error identity 保留；phase 1773 probe 不伪装 alive）', () => {
    const daemonDir = testClawDaemonDir(tempDir, 'eperm-claw');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    const probeErr = new Error('Operation not permitted') as NodeJS.ErrnoException;
    probeErr.code = 'EPERM';
    const ctx = makeCtx({
      l1IsAlive: vi.fn().mockImplementation(() => {
        throw probeErr;
      }),
    });

    const result = liveness(ctx, daemonDir);
    expect(result).toEqual({ kind: 'probe_unavailable', pid: process.pid, error: probeErr });
    if (result.kind === 'probe_unavailable') {
      expect(result.error).toBe(probeErr); // error identity 保留，不压平
    }
  });

  it('missing active generation → absent{missing_active}', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'no-gen');

    expect(liveness(ctx, daemonDir)).toEqual({ kind: 'absent', reason: 'missing_active' });
  });

  it('active 无 pid.json → absent{missing_pid}', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'no-pid');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    fsSync.rmSync(path.join(daemonDir, 'status', 'process', 'active', 'pid.json'));

    expect(liveness(ctx, daemonDir)).toEqual({ kind: 'absent', reason: 'missing_pid' });
  });

  it('corrupt generation.json → malformed{file:generation.json}', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'corrupt-gen');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    fsSync.writeFileSync(
      path.join(daemonDir, 'status', 'process', 'active', 'generation.json'),
      'not-json',
      'utf-8',
    );

    const result = liveness(ctx, daemonDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.file).toBe('generation.json');
      expect(result.evidence).toBeDefined();
    }
  });

  it('corrupt pid.json → malformed{file:pid.json}', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'corrupt-pid');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });
    fsSync.writeFileSync(
      path.join(daemonDir, 'status', 'process', 'active', 'pid.json'),
      'not-json',
      'utf-8',
    );

    const result = liveness(ctx, daemonDir);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.file).toBe('pid.json');
      expect(result.evidence).toBeDefined();
    }
  });

  it('pid generation_id 与 active 不匹配 → malformed{file:pid.json, evidence:pid_generation_mismatch}', () => {
    const ctx = makeCtx();
    const daemonDir = testClawDaemonDir(tempDir, 'mismatch-pid');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-active', pid: process.pid });
    // 覆盖 pid.json：pid 事实不属于 active generation（磁盘证据完整性损坏，fail-closed 不猜）
    fsSync.writeFileSync(
      path.join(daemonDir, 'status', 'process', 'active', 'pid.json'),
      JSON.stringify({
        schema_version: 1,
        generation_id: 'gen-other',
        pid: process.pid,
        created_at: new Date().toISOString(),
      }),
      'utf-8',
    );

    expect(liveness(ctx, daemonDir)).toEqual({
      kind: 'malformed',
      file: 'pid.json',
      evidence: 'pid_generation_mismatch',
    });
  });

  it('generation.json 非 ENOENT 读失败 → malformed{file:generation.json}（cause identity 保留）', () => {
    const { audit } = makeAudit();
    const daemonDir = testClawDaemonDir(tempDir, 'read-fail-gen');
    writeActiveGenerationSync(daemonDir, { generationId: 'gen-1', pid: process.pid });

    const result = liveness(
      { fs: fsWithReadFailure('generation.json'), audit, l1IsAlive: vi.fn().mockReturnValue(true) },
      daemonDir,
    );
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.file).toBe('generation.json');
      expect((result.evidence as NodeJS.ErrnoException).code).toBe('EACCES');
    }
  });
});

describe('describeLiveness rendering (phase 1773 contract)', () => {
  it('renders alive/dead/absent×2/malformed×2/probe_unavailable', () => {
    expect(describeLiveness(aliveLiveness(123))).toBe('PID 123');
    expect(describeLiveness(aliveLiveness(123, 'Fri May 30 13:00:00 2026'))).toBe('PID 123');
    expect(describeLiveness(deadLiveness(123))).toBe('PID 123 not alive');

    expect(describeLiveness(absentLiveness('missing_active'))).toBe('no active generation');
    expect(describeLiveness(absentLiveness('missing_pid'))).toBe('active generation without pid fact');

    const genErr = new SyntaxError('Unexpected token');
    expect(describeLiveness(malformedLiveness('generation.json', genErr))).toBe(
      `malformed active generation: ${formatErr(genErr)}`,
    );
    expect(describeLiveness(malformedLiveness('pid.json', 'pid_shape_mismatch'))).toBe(
      'malformed active pid: pid_shape_mismatch',
    );
    expect(describeLiveness(malformedLiveness('pid.json', 'pid_generation_mismatch'))).toBe(
      'active pid generation mismatch',
    );

    const probeErr = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    expect(describeLiveness(probeUnavailableLiveness(123, probeErr))).toBe(
      `probe unavailable: ${formatErr(probeErr)}`,
    );
  });

  it('decision must use discriminant: rendered strings stay stable for mocks/log', () => {
    // 渲染是纯投影：同一 input 恒等（snapshot 稳定性，防止 caller 反推状态）
    const r = probeUnavailableLiveness(7, new Error('boom'));
    expect(describeLiveness(r)).toBe(describeLiveness(r));
  });
});
