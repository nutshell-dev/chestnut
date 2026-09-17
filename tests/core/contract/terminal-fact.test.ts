/**
 * Phase 1846 Step B: readContractTerminalFact 只读终态事实查询。
 *
 * 矩阵（对应 coding plan/phase1846 Step B §6）：
 *  1. 四 state 真实 persistLifecycleIntent → unconfirmed；真实 commitTerminalLifecycle → terminal(state)
 *  2. 仅 active / active 全完成 progress / 仅 intent / 仅 .creating active / 全不存在 → unconfirmed
 *  3. 仅 legacy paused 或 flat archive（progress 宣称 completed 亦然）→ unconfirmed
 *  4. active+archive（含 .creating）/ 双 archive / legacy+current → ContractLocationAmbiguityError
 *  5. archive payload 丢失或坏 JSON 仍 terminal；候选根为文件 → ContractLayoutCorruptedError 且磁盘不变
 *  6. 真 NodeFileSystem 缺失（FileNotFoundError）与注入 ENOENT → unconfirmed；
 *     EACCES/EIO/ENOTDIR 原异常上抛（含已发现 archive 后的后续候选失败）
 *  7. 非法 ID 拒绝且 stat 零调用；跨 claw 同 ID 只查询注入的根
 *  8. 成功/失败查询前后目录清单与文件字节不变；接口只需真实 stat
 *  9. 明控 stat 时序跨 rename：本次冲突抛错，下一次重新观察返回 terminal
 * 10. 公共 index 导入新函数与结果类型可编译并运行
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FileNotFoundError, type FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import {
  readContractTerminalFact,
  type ContractTerminalFact,
} from '../../../src/core/contract/terminal-fact.js';
import {
  readContractTerminalFact as readContractTerminalFactFromBarrel,
} from '../../../src/core/contract/index.js';
import type { ContractTerminalFact as ContractTerminalFactFromBarrel } from '../../../src/core/contract/index.js';
import { commitTerminalLifecycle, type LifecycleContext } from '../../../src/core/contract/lifecycle.js';
import {
  persistLifecycleIntent,
  buildCompletedIntent,
  buildCancelledIntent,
  buildCorruptedIntent,
  buildFailedIntent,
} from '../../../src/core/contract/lifecycle-intent.js';
import { archiveStateContainerDir } from '../../../src/core/contract/locations.js';
import {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_ARCHIVE_DIR,
  CONTRACT_PAUSED_DIR,
} from '../../../src/core/contract/dirs.js';
import { CREATION_CLAIM_FILE } from '../../../src/core/contract/creation.js';
import {
  ARCHIVE_STATE_DIRS_TUPLE,
  makeArchiveDir,
  makeContractId,
  type ArchiveState,
  type ContractId,
  type LifecycleIntent,
} from '../../../src/core/contract/types.js';
import {
  ContractLayoutCorruptedError,
  ContractLocationAmbiguityError,
} from '../../../src/core/contract/errors.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

/** 查询只注入真实 stat 的窄对象，证明接口不需要 FileSystem 的其他能力。 */
let statOnly: Pick<FileSystem, 'stat'>;

const silentAudit = { write: () => {} } as unknown as AuditLog;

beforeEach(async () => {
  tmpDir = await createTempDir('test-terminal-fact-');
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fsp.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
  statOnly = { stat: (p: string) => nodeFs.stat(p) };
});

afterEach(async () => {
  await cleanupTempDir(tmpDir);
});

function buildIntentForState(contractId: ContractId, requestId: string, state: ArchiveState): LifecycleIntent {
  switch (state) {
    case 'completed':
      return buildCompletedIntent(contractId, requestId, 'terminal-fact-test');
    case 'cancelled':
      return buildCancelledIntent(contractId, requestId, 'terminal-fact-test');
    case 'corrupted':
      return buildCorruptedIntent(contractId, requestId, {
        reason: 'yaml_parse_error',
        relativePath: 'contract.yaml',
      });
    case 'failed':
      return buildFailedIntent(contractId, requestId, {
        reason: 'terminal-fact-test',
        evidenceRef: 'terminal-fact-test',
        producer: 'terminal-fact-test',
      });
  }
}

/**
 * 类型化 LifecycleContext：commit 实际只使用 fs/audit/baseDir/activeDir/archiveDir，
 * 其余依赖一旦触发即抛 unexpected call（不复制提交实现、不 mock 查询）。
 */
function makeLifecycleCtx(): LifecycleContext {
  const unexpected = (name: string) => (): never => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    fs: nodeFs,
    audit: silentAudit,
    baseDir: '.',
    activeDir: CONTRACT_ACTIVE_DIR,
    archiveDir: makeArchiveDir(CONTRACT_ARCHIVE_DIR),
    contractDir: unexpected('contractDir'),
    loadContract: unexpected('loadContract'),
    getProgress: unexpected('getProgress'),
    checkAllSubtasksCompleted: unexpected('checkAllSubtasksCompleted'),
    abortContractVerifiers: unexpected('abortContractVerifiers'),
  };
}

const ALL_COMPLETED_PROGRESS = JSON.stringify({
  schema_version: 1,
  contract_id: 'irrelevant',
  status: 'completed',
  subtasks: { t1: { status: 'completed', completed_at: '2026-09-17T00:00:00.000Z' } },
}, null, 2);

async function snapshotTree(absRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  async function walk(rel: string): Promise<void> {
    const entries = await fsp.readdir(path.join(absRoot, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        map.set(childRel, '<dir>');
        await walk(childRel);
      } else {
        map.set(childRel, await fsp.readFile(path.join(absRoot, childRel), 'utf8'));
      }
    }
  }
  await walk('');
  return map;
}

describe('phase 1846 Step B: readContractTerminalFact', () => {
  // 矩阵 1：真实提交链，四种终态
  it.each(ARCHIVE_STATE_DIRS_TUPLE)(
    'real intent is unconfirmed; real commitTerminalLifecycle commits terminal %s',
    async (state) => {
      const contractId = makeContractId(`c-live-${state}`);
      await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${contractId}`);
      await nodeFs.writeAtomic(`${CONTRACT_ACTIVE_DIR}/${contractId}/contract.yaml`, 'id: x\n');

      const intent = buildIntentForState(contractId, `req-${state}`, state);
      await persistLifecycleIntent(nodeFs, silentAudit, '.', intent);
      // intent 先行不是提交：仍 unconfirmed
      await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({ kind: 'unconfirmed' });

      const outcome = await commitTerminalLifecycle(makeLifecycleCtx(), contractId, intent);
      expect(outcome.kind).toBe('committed');

      await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({
        kind: 'terminal',
        state,
      });
    },
  );

  // 矩阵 2：非终态证据均 unconfirmed
  it.each([
    ['only active dir', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${id}`);
    }],
    ['active dir whose progress claims all completed', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${id}`);
      await nodeFs.writeAtomic(`${CONTRACT_ACTIVE_DIR}/${id}/progress.json`, ALL_COMPLETED_PROGRESS);
    }],
    ['only persisted completed intent, no directories', async (id: ContractId) => {
      await persistLifecycleIntent(nodeFs, silentAudit, '.', buildCompletedIntent(id, 'req-only-intent', 't'));
    }],
    ['only .creating (unpublished) active dir', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${id}`);
      await nodeFs.writeAtomic(`${CONTRACT_ACTIVE_DIR}/${id}/${CREATION_CLAIM_FILE}`, '');
    }],
    ['nothing exists at all', async (_id: ContractId) => {}],
  ])('unconfirmed: %s', async (_label, arrange) => {
    const contractId = makeContractId('c-unconfirmed');
    await arrange(contractId);
    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({ kind: 'unconfirmed' });
  });

  // 矩阵 3：legacy 布局不是终态证据
  it.each([
    ['legacy paused dir', CONTRACT_PAUSED_DIR],
    ['legacy flat archive dir', CONTRACT_ARCHIVE_DIR],
  ])('unconfirmed: only %s, even with completed progress', async (_label, container) => {
    const contractId = makeContractId('c-legacy');
    await nodeFs.ensureDir(`${container}/${contractId}`);
    await nodeFs.writeAtomic(`${container}/${contractId}/progress.json`, ALL_COMPLETED_PROGRESS);
    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({ kind: 'unconfirmed' });
  });

  // 矩阵 4：多位置冲突 fail-closed
  it.each([
    ['active + current archive', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${id}`);
      await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed/${id}`);
      return [`${CONTRACT_ACTIVE_DIR}/${id}`, `${CONTRACT_ARCHIVE_DIR}/completed/${id}`];
    }],
    ['.creating active + current archive', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${id}`);
      await nodeFs.writeAtomic(`${CONTRACT_ACTIVE_DIR}/${id}/${CREATION_CLAIM_FILE}`, '');
      await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/cancelled/${id}`);
      return [`${CONTRACT_ACTIVE_DIR}/${id}`, `${CONTRACT_ARCHIVE_DIR}/cancelled/${id}`];
    }],
    ['two current archives', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed/${id}`);
      await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/failed/${id}`);
      return [`${CONTRACT_ARCHIVE_DIR}/completed/${id}`, `${CONTRACT_ARCHIVE_DIR}/failed/${id}`];
    }],
    ['legacy flat + current archive', async (id: ContractId) => {
      await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/${id}`);
      await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/corrupted/${id}`);
      return [`${CONTRACT_ARCHIVE_DIR}/${id}`, `${CONTRACT_ARCHIVE_DIR}/corrupted/${id}`];
    }],
  ])('ambiguity: %s throws ContractLocationAmbiguityError with all observed locations', async (_label, arrange) => {
    const contractId = makeContractId('c-ambiguous');
    const expectedLocations = await arrange(contractId);
    const error = await readContractTerminalFact(statOnly, contractId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractLocationAmbiguityError);
    expect((error as ContractLocationAmbiguityError).contractId).toBe(contractId);
    expect((error as ContractLocationAmbiguityError).locations).toEqual(expectedLocations);
  });

  // 矩阵 5：只消费生命周期位置，不读 payload
  it('terminal even when archive payload is missing entirely', async () => {
    const contractId = makeContractId('c-no-payload');
    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed/${contractId}`);
    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({
      kind: 'terminal',
      state: 'completed',
    });
  });

  it('terminal even when archive payload is corrupted bytes', async () => {
    const contractId = makeContractId('c-bad-payload');
    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/failed/${contractId}`);
    await nodeFs.writeAtomic(`${CONTRACT_ARCHIVE_DIR}/failed/${contractId}/progress.json`, '{not json');
    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({
      kind: 'terminal',
      state: 'failed',
    });
  });

  it('candidate path that is a file throws ContractLayoutCorruptedError and leaves disk untouched', async () => {
    const contractId = makeContractId('c-not-a-dir');
    await nodeFs.ensureDir(CONTRACT_ARCHIVE_DIR);
    const filePath = `${CONTRACT_ARCHIVE_DIR}/completed/${contractId}`;
    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed`);
    await nodeFs.writeAtomic(filePath, 'i am a file');
    const before = await snapshotTree(clawDir);

    const error = await readContractTerminalFact(statOnly, contractId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractLayoutCorruptedError);
    expect((error as ContractLayoutCorruptedError).context).toMatchObject({
      root: filePath,
      cause: 'terminal_fact_non_directory',
    });
    expect(await snapshotTree(clawDir)).toEqual(before);
  });

  // 矩阵 6：缺席与 IO 失败严格区分
  it('real NodeFileSystem: missing candidates raise FileNotFoundError and fold to unconfirmed', async () => {
    const contractId = makeContractId('c-absent');
    await expect(nodeFs.stat(`${CONTRACT_ACTIVE_DIR}/${contractId}`)).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({ kind: 'unconfirmed' });
  });

  it('injected raw ENOENT counts as absent', async () => {
    const contractId = makeContractId('c-raw-enoent');
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const fs = { stat: async () => { throw enoent; } };
    await expect(readContractTerminalFact(fs, contractId)).resolves.toEqual({ kind: 'unconfirmed' });
  });

  it.each(['EACCES', 'EIO', 'ENOTDIR'])('injected %s is rethrown as the original error', async (code) => {
    const contractId = makeContractId(`c-${code.toLowerCase()}`);
    const original = Object.assign(new Error(`${code}: injected`), { code });
    const fs = { stat: async () => { throw original; } };
    await expect(readContractTerminalFact(fs, contractId)).rejects.toBe(original);
  });

  it('IO failure on a later candidate after an archive was observed still throws (no early terminal)', async () => {
    const contractId = makeContractId('c-late-failure');
    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed/${contractId}`);
    const original = Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
    const failAfter = `${CONTRACT_ARCHIVE_DIR}/cancelled/${contractId}`;
    const fs = {
      stat: async (p: string) => {
        if (p === failAfter) throw original;
        return nodeFs.stat(p);
      },
    };
    await expect(readContractTerminalFact(fs, contractId)).rejects.toBe(original);
  });

  // 矩阵 7：ID 校验与根隔离
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])(
    'rejects illegal id %j with TypeError before any stat call',
    async (badId) => {
      let statCalls = 0;
      const fs = { stat: async () => { statCalls++; throw new FileNotFoundError('x'); } };
      await expect(readContractTerminalFact(fs, badId as ContractId)).rejects.toBeInstanceOf(TypeError);
      expect(statCalls).toBe(0);
    },
  );

  it('same id in two claws: only the injected root is queried', async () => {
    const otherClawDir = path.join(tmpDir, 'claws', 'other-claw');
    await fsp.mkdir(otherClawDir, { recursive: true });
    const otherFs = new NodeFileSystem({ baseDir: otherClawDir });
    const contractId = makeContractId('c-shared');

    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed/${contractId}`);

    const observedPaths: string[] = [];
    const recordingFs = {
      stat: async (p: string) => {
        observedPaths.push(p);
        return otherFs.stat(p);
      },
    };

    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({
      kind: 'terminal',
      state: 'completed',
    });
    await expect(readContractTerminalFact(recordingFs, contractId)).resolves.toEqual({ kind: 'unconfirmed' });
    // 只出现 owner 常量构建的相对候选路径，不读取相邻 claw 或共享目录
    for (const p of observedPaths) {
      expect(p.startsWith('contract/')).toBe(true);
      expect(p).not.toContain('..');
      expect(p.endsWith(`/${contractId}`)).toBe(true);
    }
  });

  // 矩阵 8：查询无磁盘副作用
  it('successful and failing queries leave directory tree and file bytes unchanged', async () => {
    const terminalId = makeContractId('c-side-effect-terminal');
    const conflictId = makeContractId('c-side-effect-conflict');
    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/cancelled/${terminalId}`);
    await nodeFs.writeAtomic(`${CONTRACT_ARCHIVE_DIR}/cancelled/${terminalId}/progress.json`, ALL_COMPLETED_PROGRESS);
    await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${conflictId}`);
    await nodeFs.writeAtomic(`${CONTRACT_ACTIVE_DIR}/${conflictId}/contract.yaml`, 'id: x\n');
    await nodeFs.ensureDir(`${CONTRACT_ARCHIVE_DIR}/completed/${conflictId}`);

    const before = await snapshotTree(clawDir);

    await expect(readContractTerminalFact(statOnly, terminalId)).resolves.toEqual({
      kind: 'terminal',
      state: 'cancelled',
    });
    await expect(readContractTerminalFact(statOnly, makeContractId('c-side-effect-absent'))).resolves.toEqual({
      kind: 'unconfirmed',
    });
    await expect(readContractTerminalFact(statOnly, conflictId)).rejects.toBeInstanceOf(
      ContractLocationAmbiguityError,
    );

    expect(await snapshotTree(clawDir)).toEqual(before);
  });

  // 矩阵 9：跨 rename 的明控观察 → 保守冲突；下一次重新观察
  it('rename observed mid-scan throws ambiguity; the next call re-observes terminal', async () => {
    const contractId = makeContractId('c-race');
    await nodeFs.ensureDir(`${CONTRACT_ACTIVE_DIR}/${contractId}`);

    let renamed = false;
    const racingFs = {
      stat: async (p: string) => {
        const info = await nodeFs.stat(p);
        if (!renamed && p === `${CONTRACT_ACTIVE_DIR}/${contractId}`) {
          renamed = true;
          // 真实 rename：active → archive/cancelled（模拟并发终态提交）
          await nodeFs.ensureDir(archiveStateContainerDir(CONTRACT_ARCHIVE_DIR, 'cancelled'));
          await nodeFs.moveDir(
            `${CONTRACT_ACTIVE_DIR}/${contractId}`,
            `${CONTRACT_ARCHIVE_DIR}/cancelled/${contractId}`,
          );
        }
        return info;
      },
    };

    const error = await readContractTerminalFact(racingFs, contractId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractLocationAmbiguityError);
    expect((error as ContractLocationAmbiguityError).locations).toEqual([
      `${CONTRACT_ACTIVE_DIR}/${contractId}`,
      `${CONTRACT_ARCHIVE_DIR}/cancelled/${contractId}`,
    ]);

    // 查询自身无重试/写动作；下一次调用重新观察即 terminal
    await expect(readContractTerminalFact(statOnly, contractId)).resolves.toEqual({
      kind: 'terminal',
      state: 'cancelled',
    });
  });

  // 矩阵 10：公共 barrel 导出可用
  it('public barrel exports the query function and result type', async () => {
    expect(readContractTerminalFactFromBarrel).toBe(readContractTerminalFact);
    const fact: ContractTerminalFactFromBarrel = await readContractTerminalFactFromBarrel(
      statOnly,
      makeContractId('c-barrel'),
    );
    const narrowed: ContractTerminalFact = fact;
    expect(narrowed).toEqual({ kind: 'unconfirmed' });
  });
});
