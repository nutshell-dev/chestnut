/**
 * Phase 188 Step A: archive 入口 status precondition
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { ToolError } from '../../../src/foundation/errors.js';
import { moveContractToArchive, type LifecycleContext } from '../../../src/core/contract/lifecycle.js';
import type { Contract, ProgressData } from '../../../src/core/contract/types.js';

describe('Phase 188 Step A: moveContractToArchive precondition', () => {
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

  function makeCtx(): LifecycleContext {
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
      checkAllSubtasksCompleted: async () => true,
      abortContractVerifiers: () => {},
    };
  }

  async function setupContractInDir(
    dirName: 'active' | 'paused',
    contractId: string,
    status: string,
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
        status,
        subtasks: {},
        checkpoint: null,
      }, null, 2)
    );
  }

  // 4 终态 → 通过
  it('allows archive when status=completed', async () => {
    const contractId = 'c-completed';
    await setupContractInDir('active', contractId, 'completed');
    await moveContractToArchive(makeCtx(), contractId);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  it('allows archive when status=cancelled', async () => {
    const contractId = 'c-cancelled';
    await setupContractInDir('active', contractId, 'cancelled');
    await moveContractToArchive(makeCtx(), contractId);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  it('allows archive when status=crashed', async () => {
    const contractId = 'c-crashed';
    await setupContractInDir('active', contractId, 'crashed');
    await moveContractToArchive(makeCtx(), contractId);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  it('allows archive when status=archive_pending_recovery', async () => {
    const contractId = 'c-recovery';
    await setupContractInDir('active', contractId, 'archive_pending_recovery');
    await moveContractToArchive(makeCtx(), contractId);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(true);
  });

  // 3 active 态 → throw + audit emit + dir 未移
  it('rejects archive when status=pending + emits audit + dir stays', async () => {
    const contractId = 'c-pending';
    await setupContractInDir('active', contractId, 'pending');
    await expect(moveContractToArchive(makeCtx(), contractId)).rejects.toThrow(ToolError);
    await expect(moveContractToArchive(makeCtx(), contractId)).rejects.toThrow('cannot be archived: status=pending');

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(true);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(false);

    const audit = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_PRECONDITION_VIOLATED);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].args.some(a => a.includes('status=pending'))).toBe(true);
  });

  it('rejects archive when status=running + emits audit + dir stays', async () => {
    const contractId = 'c-running';
    await setupContractInDir('active', contractId, 'running');
    await expect(moveContractToArchive(makeCtx(), contractId)).rejects.toThrow(ToolError);
    await expect(moveContractToArchive(makeCtx(), contractId)).rejects.toThrow('cannot be archived: status=running');

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(true);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(false);

    const audit = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_PRECONDITION_VIOLATED);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].args.some(a => a.includes('status=running'))).toBe(true);
  });

  it('rejects archive when status=paused + emits audit + dir stays', async () => {
    const contractId = 'c-paused';
    await setupContractInDir('paused', contractId, 'paused');
    await expect(moveContractToArchive(makeCtx(), contractId)).rejects.toThrow(ToolError);
    await expect(moveContractToArchive(makeCtx(), contractId)).rejects.toThrow('cannot be archived: status=paused');

    const pausedDir = path.join(clawDir, 'contract', 'paused', contractId);
    expect(await fs.stat(pausedDir).then(() => true).catch(() => false)).toBe(true);
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    expect(await fs.stat(archiveDir).then(() => true).catch(() => false)).toBe(false);

    const audit = auditCalls.filter(c => c.type === CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_PRECONDITION_VIOLATED);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].args.some(a => a.includes('status=paused'))).toBe(true);
  });
});
