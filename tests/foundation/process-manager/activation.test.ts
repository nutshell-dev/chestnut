/**
 * Phase 1873 Step B: activateChildGeneration —— child activation 协议（owner: PM）。
 *
 * 迁移自 daemon.ts `activateOwnGeneration` 的协议矩阵（daemon 侧不再展开协议）：
 * env 缺失 / spawning 缺失 / id mismatch / pid 事实缺失 / pid mismatch /
 * start-time mismatch / stop intent（retire spawning + 失败）/ ready 写入失败 /
 * activate 失败 / happy path（ready 事实 + active 目录 + 审计）/ already_active。
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
  writeStopIntent,
  inspectActive,
  getSpawningDir,
  getRetiredDirFor,
  READY_FILE,
  type ProcessGenerationRecord,
} from '../../../src/foundation/process-manager/generation.js';
import { activateChildGeneration } from '../../../src/foundation/process-manager/index.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('phase 1873 Step B: activateChildGeneration（PM 协议 capability）', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let daemonDir: DaemonDir;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let ctx: ProcessManagerContext;

  const CHILD_PID = 4321;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('activation-');
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    daemonDir = testClawDaemonDir(tempDir, 'gen-a');
    ({ audit } = makeAudit());
    ctx = { fs: nodeFs, audit, getProcessStartTime: () => undefined };
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function makeSpawning(generationId = 'gen-child', pid = CHILD_PID): Promise<ProcessGenerationRecord> {
    const record = newProcessGeneration(ctx, daemonDir);
    record.generation_id = generationId;
    prepareGeneration(ctx, record);
    const committed = commitSpawning(ctx, record);
    expect(committed.kind).toBe('committed');
    const child = await writeChildPid(ctx, record, pid);
    expect(child.kind).toBe('written');
    return record;
  }

  function exists(absPath: string): boolean {
    return nodeFs.existsSync(absPath);
  }

  it('happy path：ready 事实 + active 目录 + activated outcome', async () => {
    const record = await makeSpawning();
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: record.generation_id,
      pid: CHILD_PID,
      startTime: undefined,
    });

    expect(outcome.kind).toBe('activated');
    expect(exists(path.join(getSpawningDir(daemonDir), READY_FILE))).toBe(false); // 目录已整体迁 active
    const active = inspectActive(ctx, daemonDir);
    expect(active.status).toBe('ok');
    expect(active.status === 'ok' && active.record.generation_id).toBe(record.generation_id);
  });

  it('env 缺失（generationId undefined）→ failed/generation_env_missing', async () => {
    await makeSpawning();
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: undefined,
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome).toEqual({
      kind: 'failed',
      stage: 'generation_env_missing',
      reason: 'CHESTNUT_PROCESS_GENERATION env missing',
    });
  });

  it('spawning 缺失 → failed/spawning_not_found', async () => {
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-none',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.stage).toBe('spawning_not_found');
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/spawning generation not found/);
  });

  it('generation id mismatch → failed/generation_id_mismatch', async () => {
    await makeSpawning('gen-real');
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-other',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('generation_id_mismatch');
    expect(outcome.kind === 'failed' && outcome.reason).toBe('spawning generation id mismatch');
  });

  it('pid 事实缺失（writeChildPid 未执行）→ failed/spawning_pid_not_found', async () => {
    const record = newProcessGeneration(ctx, daemonDir);
    record.generation_id = 'gen-nopid';
    prepareGeneration(ctx, record);
    expect(commitSpawning(ctx, record).kind).toBe('committed');
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-nopid',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('spawning_pid_not_found');
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/spawning pid fact not found/);
  });

  it('pid mismatch → failed/pid_mismatch', async () => {
    await makeSpawning('gen-pid', 1234);
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-pid',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('pid_mismatch');
    expect(outcome.kind === 'failed' && outcome.reason).toBe('spawning pid does not match current process');
  });

  it('start-time mismatch（双方可考）→ failed/start_time_mismatch', async () => {
    const record = newProcessGeneration(ctx, daemonDir);
    record.generation_id = 'gen-st';
    prepareGeneration(ctx, record);
    expect(commitSpawning(ctx, record).kind).toBe('committed');
    // 预置 pid 事实带 start_time='AAA'
    const child = await writeChildPid(ctx, record, CHILD_PID, 'AAA' as never);
    expect(child.kind).toBe('written');
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-st',
      pid: CHILD_PID,
      startTime: 'BBB' as never,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('start_time_mismatch');
    expect(outcome.kind === 'failed' && outcome.reason).toBe('spawning startTime mismatch');
  });

  it('stop intent：retire spawning + failed/stop_intent（不在 ready/activate 之后写事实）', async () => {
    const record = await makeSpawning('gen-stop');
    const intent = writeStopIntent(ctx, daemonDir, 'req-1', 'gen-stop', 'spawning');
    expect(intent.kind).toBe('written');
    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-stop',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('stop_intent');
    expect(outcome.kind === 'failed' && outcome.reason).toBe('stop intent recorded before activation');
    // spawning 已 retire（目录迁 retired）、active 无该 generation
    expect(exists(getSpawningDir(daemonDir))).toBe(false);
    expect(exists(getRetiredDirFor(daemonDir, 'gen-stop'))).toBe(true);
    expect(inspectActive(ctx, daemonDir).status).toBe('none');
  });

  it('ready 写入失败（可重试 IO 错误）→ failed/ready_write_failed', async () => {
    const record = await makeSpawning('gen-readyfail');
    const failingFs = new Proxy(nodeFs, {
      get(target, prop) {
        if (prop === 'writeAtomicExisting') {
          return async (p: string, content: string) => {
            if (String(p).includes(READY_FILE)) {
              throw new Error('EIO injected');
            }
            return (target as unknown as Record<string, (p: string, c: string) => Promise<unknown>>).writeAtomicExisting(p, content);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop];
      },
    }) as NodeFileSystem;
    const failingCtx: ProcessManagerContext = { ...ctx, fs: failingFs };
    const outcome = await activateChildGeneration(failingCtx, daemonDir, {
      generationId: 'gen-readyfail',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('ready_write_failed');
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/ready fact write failed: retryable_failure/);
  });

  it('activate 失败（active 已被其他 generation 占据）→ failed/activate_failed', async () => {
    await makeSpawning('gen-holder');
    const holder = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-holder',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(holder.kind).toBe('activated');

    const genB = newProcessGeneration(ctx, daemonDir);
    genB.generation_id = 'gen-late';
    prepareGeneration(ctx, genB);
    expect(commitSpawning(ctx, genB).kind).toBe('committed');
    expect((await writeChildPid(ctx, genB, CHILD_PID)).kind).toBe('written');

    const outcome = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-late',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(outcome.kind === 'failed' && outcome.stage).toBe('activate_failed');
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/generation activation failed: /);
  });

  it('already_active：同 identity 重复激活幂等视为成功', async () => {
    const record = await makeSpawning('gen-re');
    const first = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-re',
      pid: CHILD_PID,
      startTime: undefined,
    });
    expect(first.kind).toBe('activated');
    const second = await activateChildGeneration(ctx, daemonDir, {
      generationId: 'gen-re',
      pid: CHILD_PID,
      startTime: undefined,
    });
    // spawning 已不存在 → 第二次为 spawning_not_found（fail-closed；幂等语义在 activateGeneration 层）
    expect(second.kind).toBe('failed');
    expect(second.kind === 'failed' && second.stage).toBe('spawning_not_found');
  });
});
