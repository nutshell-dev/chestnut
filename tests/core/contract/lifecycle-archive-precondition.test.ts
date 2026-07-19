/**
 * Phase 1132 Step D: archive 入口 precondition 改为基于业务事实。
 * 目录 rename 是 lifecycle 唯一提交点；moveContractToArchive 的 completed 目标
 * 要求所有 subtasks 完成，cancelled/corrupted 由各自专用入口调用。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { ToolError } from '../../../src/foundation/tools/errors.js';
import { moveContractToArchive, type LifecycleContext } from '../../../src/core/contract/lifecycle.js';
import type { Contract, ProgressData } from '../../../src/core/contract/types.js';

describe('Phase 1132 Step D: moveContractToArchive precondition', () => {
  let tempDir: string;
  let clawDir: string;
  let auditCalls: Array<{ type: string; args: string[] }>;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(overrides: { checkAllSubtasksCompleted?: boolean } = {}): LifecycleContext {
    const audit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return {
      fs: nodeFs,
      audit: audit as any,
      activeDir: path.join(clawDir, 'contract', 'active'),
      pausedDir: path.join(clawDir, 'contract', 'paused'),
      archiveDir: path.join(clawDir, 'contract', 'archive') as any,
      contractDir: async (id: string) => {
        for (const d of ['active', 'paused', 'archive']) {
          const dir = path.join(clawDir, 'contract', d, id);
          if (await fs.stat(dir).then(() => true).catch(() => false)) return dir;
        }
        return path.join(clawDir, 'contract', 'active', id);
      },
      loadContract: async () => ({ id: 'test' } as Contract),
      getProgress: async (id: string) => {
        const progressPath = path.join(clawDir, 'contract', 'active', id, 'progress.json');
        try {
          const raw = await fs.readFile(progressPath, 'utf-8');
          return JSON.parse(raw) as ProgressData;
        } catch {
          const pausedPath = path.join(clawDir, 'contract', 'paused', id, 'progress.json');
          try {
            const raw = await fs.readFile(pausedPath, 'utf-8');
            return JSON.parse(raw) as ProgressData;
          } catch {
            return null;
          }
        }
      },
      saveProgress: async (id: string, progress: ProgressData) => {
        const dir = path.join(clawDir, 'contract', 'active', id);
        await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify(progress, null, 2));
      },
      checkAllSubtasksCompleted: async () => overrides.checkAllSubtasksCompleted ?? true,
      abortContractVerifiers: () => {},
    };
  }

  async function setupContractInDir(
    dirName: 'active' | 'paused',
    contractId: string,
    subtaskStatus: 'todo' | 'completed' = 'completed',
  ) {
    const contractDir = path.join(clawDir, 'contract', dirName, contractId);
    await fs.mkdir(contractDir, { recursive: true });
    const yaml = await import('js-yaml');
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      yaml.dump(makeContractYaml({
        title: 'Precondition Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }))
    );
    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({ schema_version: 1,
        contract_id: contractId,
        subtasks: { t1: { status: subtaskStatus } },
        checkpoint: null,
      }, null, 2)
    );
  }

  it('allows completed archive when all subtasks completed', async () => {
    const contractId = 'c-completed';
    await setupContractInDir('active', contractId, 'completed');
    await moveContractToArchive(makeCtx({ checkAllSubtasksCompleted: true }), contractId, 'completed');
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  it('rejects completed archive when not all subtasks completed', async () => {
    const contractId = 'c-running';
    await setupContractInDir('active', contractId, 'todo');
    await expect(
      moveContractToArchive(makeCtx({ checkAllSubtasksCompleted: false }), contractId, 'completed'),
    ).rejects.toThrow(ToolError);
    await expect(
      moveContractToArchive(makeCtx({ checkAllSubtasksCompleted: false }), contractId, 'completed'),
    ).rejects.toThrow('not all subtasks are completed');

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(true);
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(false);

    const audit = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_PRECONDITION_VIOLATED);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].args.some(a => a.includes('context=moveContractToArchive.completed'))).toBe(true);
  });

  it('allows cancelled archive from active', async () => {
    const contractId = 'c-cancelled';
    await setupContractInDir('active', contractId, 'todo');
    await moveContractToArchive(makeCtx(), contractId, 'cancelled');
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  it('allows corrupted archive from active', async () => {
    const contractId = 'c-corrupted';
    await setupContractInDir('active', contractId, 'todo');
    await moveContractToArchive(makeCtx(), contractId, 'corrupted');
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  it('legacy paused dir is not a valid source for completed archive', async () => {
    const contractId = 'c-paused';
    await setupContractInDir('paused', contractId, 'todo');
    // contractDir cannot resolve an active source, so lock acquisition / move fails
    await expect(moveContractToArchive(makeCtx(), contractId, 'completed')).rejects.toThrow();

    const pausedDir = path.join(clawDir, 'contract', 'paused', contractId);
    expect(await fs.stat(pausedDir).then(() => true).catch(() => false)).toBe(true);
    const archiveDir = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(false);
  });
});
