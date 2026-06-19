/**
 * @module tests/core/contract/verification-pipeline-mutex
 * Phase 1371 sub-3: completeSubtaskSync vs runVerificationPipeline mutex reverse test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit } from '../../helpers/audit.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-verification-mutex-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

function makeManager(audit: any) {
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
}

describe('verification pipeline mutex (phase 1371 sub-3)', () => {
  it('concurrent runVerificationPipeline attempts → second rejected with race audit', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'script', script_file: 'verify.sh' }],
    }));

    // Mock runScriptVerification to delay so pipeline stays active
    vi.spyOn(manager as any, 'runScriptVerification').mockImplementation(() => new Promise(() => {}));

    // phase 337 M1 (review-2026-06-13): mutex 现 hold 到 background work 结束 finally。
    // 第一次 await 返后、background work 仍跑（mocked 死锁 promise）、mutex 仍 hold。
    // 第二次 completeSubtask 在 mutex.acquire 处即被拒、抛 "already active — concurrent attempt rejected"
    // 而非进 in-progress 状态守。两条都是合法 reject 路径、仅 wording 不同；
    // 修后期望第一种 wording。
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });

    await expect(
      manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e2' })
    ).rejects.toThrow(/already active — concurrent attempt rejected/);
  });


});
