/**
 * Phase 1945 Step B: updateActiveBusinessFact —— PM active 槽业务事实更新能力。
 *
 * 覆盖：happy path（旧 raw 交还 + readActiveBusinessFact 读回新值）、
 * generation/PID 不匹配、active pid 事实缺失、无 active、malformed active、
 * 写失败（retryable / ENOENT→generation_moved）、旧事实缺失（修复路径）、
 * 旧事实读失败不写新内容。至少一条用例走真实 NodeFileSystem 临时目录
 * （writeAtomicExisting 的 parent 语义不靠 fake 猜）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { testClawDaemonDir } from '../../helpers/daemon-dir.js';
import type { ProcessManagerContext, DaemonDir } from '../../../src/foundation/process-manager/types.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  writeChildPid,
  getActiveDir,
  GENERATION_FILE,
  PID_FILE,
  BUSINESS_FACT_FILE,
  type ProcessGenerationRecord,
} from '../../../src/foundation/process-manager/generation.js';
import { ProcessManager } from '../../../src/foundation/process-manager/index.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('phase 1945 Step B: updateActiveBusinessFact（PM active 业务事实更新）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let daemonDir: DaemonDir;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let ctx: ProcessManagerContext;
  let pm: ProcessManager;

  const CHILD_PID = 4321;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('business-fact-update-');
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    daemonDir = testClawDaemonDir(tempDir, 'gen-a');
    ({ audit } = makeAudit());
    ctx = { fs: nodeFs, audit, getProcessStartTime: () => undefined };
    pm = new ProcessManager(nodeFs, audit);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  /** 走完整出生协议（含 businessFact）并把 generation 激活到 active。 */
  async function makeActive(
    generationId: string,
    pid = CHILD_PID,
    businessFact?: string,
  ): Promise<ProcessGenerationRecord> {
    const record = newProcessGeneration(ctx, daemonDir);
    record.generation_id = generationId;
    prepareGeneration(ctx, record);
    expect(commitSpawning(ctx, record).kind).toBe('committed');
    expect((await writeChildPid(ctx, record, pid)).kind).toBe('written');
    const outcome = await pm.activateChildGeneration(daemonDir, {
      generationId,
      pid,
      startTime: undefined,
      ...(businessFact !== undefined ? { businessFact } : {}),
    });
    expect(outcome.kind).toBe('activated');
    return record;
  }

  function readActiveFactRaw(): string {
    return nodeFs.readSync(path.join(getActiveDir(daemonDir), BUSINESS_FACT_FILE));
  }

  it('happy path：update 成功交还旧 raw；readActiveBusinessFact 读到新 raw', async () => {
    const record = await makeActive('gen-happy', CHILD_PID, '{"v":1}');

    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result).toEqual({ kind: 'written', previousRaw: '{"v":1}' });
    expect(readActiveFactRaw()).toBe('{"v":2}');
    const fact = pm.readActiveBusinessFact(daemonDir);
    expect(fact).toEqual({ kind: 'ok', generationId: 'gen-happy', raw: '{"v":2}' });
  });

  it('generationId 不匹配 → generation_mismatch，文件内容不变', async () => {
    await makeActive('gen-real', CHILD_PID, '{"v":1}');

    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: 'gen-other', pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result).toEqual({ kind: 'generation_mismatch' });
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('pid 不匹配 → generation_mismatch，文件内容不变', async () => {
    const record = await makeActive('gen-pid', CHILD_PID, '{"v":1}');

    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: 9999 },
      '{"v":2}',
    );

    expect(result).toEqual({ kind: 'generation_mismatch' });
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('active pid 事实缺失 → generation_mismatch（只核 PID 数字不够，缺失即不认），文件内容不变', async () => {
    const record = await makeActive('gen-nopid', CHILD_PID, '{"v":1}');
    await nodeFs.delete(path.join(getActiveDir(daemonDir), PID_FILE));

    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result).toEqual({ kind: 'generation_mismatch' });
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('无 active → no_active', async () => {
    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: 'gen-none', pid: CHILD_PID },
      '{"v":2}',
    );
    expect(result).toEqual({ kind: 'no_active' });
  });

  it('active generation.json malformed → malformed_active，不写', async () => {
    const record = await makeActive('gen-mal', CHILD_PID, '{"v":1}');
    nodeFs.writeAtomicSync(path.join(getActiveDir(daemonDir), GENERATION_FILE), 'not json');

    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result.kind).toBe('malformed_active');
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('writeAtomicExisting 注入可重试失败 → retryable_failure，文件内容不变', async () => {
    const record = await makeActive('gen-eio', CHILD_PID, '{"v":1}');
    const failingFs = new Proxy(nodeFs, {
      get(target, prop) {
        if (prop === 'writeAtomicExisting') {
          return async (p: string, content: string) => {
            if (String(p).includes(BUSINESS_FACT_FILE)) {
              throw new Error('EIO injected');
            }
            return (target as unknown as Record<string, (p: string, c: string) => Promise<unknown>>).writeAtomicExisting(p, content);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop];
      },
    }) as NodeFileSystem;
    const failingPm = new ProcessManager(failingFs, audit);

    const result = await failingPm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result.kind).toBe('retryable_failure');
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('writeAtomicExisting 命中 ENOENT（目录已 move 走）→ generation_moved', async () => {
    const record = await makeActive('gen-moved', CHILD_PID, '{"v":1}');
    const failingFs = new Proxy(nodeFs, {
      get(target, prop) {
        if (prop === 'writeAtomicExisting') {
          return async (p: string, content: string) => {
            if (String(p).includes(BUSINESS_FACT_FILE)) {
              throw Object.assign(new Error('ENOENT injected'), { code: 'ENOENT' });
            }
            return (target as unknown as Record<string, (p: string, c: string) => Promise<unknown>>).writeAtomicExisting(p, content);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop];
      },
    }) as NodeFileSystem;
    const failingPm = new ProcessManager(failingFs, audit);

    const result = await failingPm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result).toEqual({ kind: 'generation_moved' });
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('旧 business.json 缺失（修复路径）→ written 且 previousRaw === undefined', async () => {
    const record = await makeActive('gen-nofact', CHILD_PID);

    const result = await pm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":1}',
    );

    expect(result).toEqual({ kind: 'written', previousRaw: undefined });
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });

  it('旧 business.json 读取非 ENOENT 失败 → retryable_failure，新内容未写入', async () => {
    const record = await makeActive('gen-readfail', CHILD_PID, '{"v":1}');
    const failingFs = new Proxy(nodeFs, {
      get(target, prop) {
        if (prop === 'readSync') {
          return (p: string) => {
            if (String(p).includes(BUSINESS_FACT_FILE)) {
              throw new Error('EIO injected');
            }
            return (target as unknown as Record<string, (p: string) => string>).readSync(p);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop];
      },
    }) as NodeFileSystem;
    const failingPm = new ProcessManager(failingFs, audit);

    const result = await failingPm.updateActiveBusinessFact(
      daemonDir,
      { generationId: record.generation_id, pid: CHILD_PID },
      '{"v":2}',
    );

    expect(result.kind).toBe('retryable_failure');
    // 旧 raw 读失败即不写新事实（避免覆盖后丢失旧身份证据）
    expect(readActiveFactRaw()).toBe('{"v":1}');
  });
});
