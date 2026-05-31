/**
 * phase 1487: event-collector 返 problemPairs + 去 [force-accepted] prefix 验证.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { collectContractEvents } from '../../../src/core/contract/jobs/event-collector.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeClawId, makeClawDir } from '../../../src/foundation/identity/index.js';

function makeAudit() {
  return { write: () => {} };
}

function makeProgress(opts: {
  contractId: string;
  subtasks: Record<string, { status: string; evidence?: string; force_accepted?: boolean; last_failed_feedback?: { feedback: string }; completed_at?: string }>;
}) {
  return JSON.stringify({
    contract_id: opts.contractId,
    status: 'completed',
    subtasks: opts.subtasks,
  });
}

describe('phase 1487: collectContractEvents result shape', () => {
  let clawforumRoot: string;
  let fs: NodeFileSystem;
  const sinceTs = new Date('2026-01-01').getTime();

  beforeEach(async () => {
    clawforumRoot = path.join(tmpdir(), `event-collector-${randomUUID()}`);
    await fsAsync.mkdir(clawforumRoot, { recursive: true });
    fs = new NodeFileSystem({ baseDir: clawforumRoot });
  });

  afterEach(async () => {
    await fsAsync.rm(clawforumRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function makeContract(clawSub: string, contractDirName: string, progressJson: string, contractYaml = '') {
    const archiveDir = path.join(clawforumRoot, clawSub, 'contract/archive', contractDirName);
    await fsAsync.mkdir(archiveDir, { recursive: true });
    await fsAsync.writeFile(path.join(archiveDir, 'progress.json'), progressJson);
    if (contractYaml) {
      await fsAsync.writeFile(path.join(archiveDir, 'contract.yaml'), contractYaml);
    }
  }

  it('clean contract → events present, problemPairs empty', async () => {
    await makeContract('claws/worker-1', '1780-abcd', makeProgress({
      contractId: '1780-abcd',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'src/login.ts', completed_at: '2026-05-31T00:00:00Z' },
      },
    }));
    const clawDir = makeClawDir(path.join(clawforumRoot, 'claws/worker-1'));
    const result = collectContractEvents(fs, clawDir, makeClawId('worker-1'), sinceTs, makeAudit());
    expect(result.events.length).toBe(1);
    expect(result.problemPairs).toEqual([]);
    expect(result.events[0]).toContain('[contract_completed] claw=worker-1 contract=1780-abcd');
    expect(result.events[0]).toContain('[st-1] src/login.ts');
  });

  it('contract with last_failure → problemPairs contains pair', async () => {
    await makeContract('claws/worker-1', '1780-cdef', makeProgress({
      contractId: '1780-cdef',
      subtasks: {
        'st-1': {
          status: 'completed',
          evidence: 'src/login.ts',
          completed_at: '2026-05-31T00:00:00Z',
          last_failed_feedback: { feedback: 'Failed test isolation' },
        },
      },
    }));
    const clawDir = makeClawDir(path.join(clawforumRoot, 'claws/worker-1'));
    const result = collectContractEvents(fs, clawDir, makeClawId('worker-1'), sinceTs, makeAudit());
    expect(result.events.length).toBe(1);
    expect(result.problemPairs).toEqual(['worker-1:1780-cdef']);
    expect(result.events[0]).toContain('⚠ last_failure: Failed test isolation');
  });

  it('force_accepted=true subtask → NO [force-accepted] prefix in body (DP cleanup)', async () => {
    await makeContract('claws/worker-1', '1780-eeee', makeProgress({
      contractId: '1780-eeee',
      subtasks: {
        'st-1': {
          status: 'completed',
          evidence: 'src/auth.ts',
          completed_at: '2026-05-31T00:00:00Z',
          force_accepted: true,  // 内部仍可能 true / 但 body 不显式标
        },
      },
    }));
    const clawDir = makeClawDir(path.join(clawforumRoot, 'claws/worker-1'));
    const result = collectContractEvents(fs, clawDir, makeClawId('worker-1'), sinceTs, makeAudit());
    expect(result.events[0]).not.toContain('[force-accepted]');
    expect(result.events[0]).toContain('[st-1] src/auth.ts');
  });

  it('multiple subtasks, some with failure → problem_pairs includes only failure entries', async () => {
    await makeContract('claws/worker-1', '1780-ffff', makeProgress({
      contractId: '1780-ffff',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'src/a.ts', completed_at: '2026-05-31T00:00:00Z' },
        'st-2': {
          status: 'completed',
          evidence: 'src/b.ts',
          completed_at: '2026-05-31T00:00:00Z',
          last_failed_feedback: { feedback: 'b broken' },
        },
      },
    }));
    const clawDir = makeClawDir(path.join(clawforumRoot, 'claws/worker-1'));
    const result = collectContractEvents(fs, clawDir, makeClawId('worker-1'), sinceTs, makeAudit());
    expect(result.problemPairs).toEqual(['worker-1:1780-ffff']);  // 单 contract / 1 pair (即便多 subtask)
  });

  it('contract before sinceTs → not included', async () => {
    await makeContract('claws/worker-1', '1780-old', makeProgress({
      contractId: '1780-old',
      subtasks: {
        'st-1': { status: 'completed', evidence: 'old.ts', completed_at: '2025-12-01T00:00:00Z' },
      },
    }));
    const clawDir = makeClawDir(path.join(clawforumRoot, 'claws/worker-1'));
    const result = collectContractEvents(fs, clawDir, makeClawId('worker-1'), sinceTs, makeAudit());
    expect(result.events).toEqual([]);
    expect(result.problemPairs).toEqual([]);
  });
});
