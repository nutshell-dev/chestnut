/**
 * Phase 1911 Step F — contract-from-dir verifier 资产一致发布
 * （RACE-CONTRACT-DIR-ASSET-PUBLISH-ORDER）
 *
 * 验收：
 * - CLI create from dir：published 合同的 verification/ 资产随 publish 一致可见，
 *   无 .creating / .creating-assets 残留；硬化过滤（扩展白名单）仍生效；
 * - 崩溃窗口：claim + 完整 staging → recoverCreation 按 durable intent 完成资产
 *   落位并 publish；staging 不完整 → fail-closed 'failed'，证据保留不发布；
 * - 资产名越界（路径分隔符/dot-file/重复）→ 创建前 typed 拒绝，不产生 claim；
 * - 已发布合同的重试仍 already_exists，不覆盖 winner 资产。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ContractSystem } from '../../src/core/contract/manager.js';
import {
  CREATION_CLAIM_FILE,
  CREATION_ASSETS_STAGING_DIR,
  buildCreationIntent,
  serializeCreationIntent,
} from '../../src/core/contract/creation.js';
import { ContractValidationError } from '../../src/core/contract/errors.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { makeAudit } from '../helpers/audit.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { contractCreateFromDirCommand } from '../../src/cli/commands/contract-create-from-dir.js';
import { makeContractId } from '../../src/core/contract/index.js';

let testDir: string;
let clawDir: string;
let originalRoot: string | undefined;

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  testDir = path.join(os.tmpdir(), `.test-cfd-assets-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  clawDir = path.join(testDir, '.chestnut', 'claws', 'alice');
  fs.mkdirSync(clawDir, { recursive: true });
  originalRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = testDir;
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  fs.rmSync(testDir, { recursive: true, force: true });
});

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

function makeManager() {
  const { audit } = makeAudit();
  return new ContractSystem({
    clawDir,
    clawId: 'alice',
    fs: new NodeFileSystem({ baseDir: clawDir }),
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory,
    clawsDir: path.join(testDir, '.chestnut', 'claws'),
    notifyClaw: vi.fn(),
  });
}

function activeDirOf(contractId: string): string {
  return path.join(clawDir, 'contract', 'active', contractId);
}

/** 源目录：contract.yaml + verification/（含一个白名单外文件）。 */
function makeSourceDir(): string {
  const src = path.join(testDir, 'src-contract');
  fs.mkdirSync(path.join(src, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(src, 'contract.yaml'), yaml.dump(makeContractYaml({
    title: 'Asset contract',
    goal: 'verify assets',
    subtasks: [{ id: 't1', description: 'do t1' }],
    verification: [{ subtask_id: 't1', type: 'script', script_file: 'verification/check.sh' }],
  })));
  fs.writeFileSync(path.join(src, 'verification', 'check.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(src, 'verification', 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(src, 'verification', 'evil.exe'), 'MZ'); // 扩展白名单外 → skip
  return src;
}

describe('contract-create-from-dir asset-consistent publish (phase 1911 Step F)', () => {
  it('CLI create from dir：published 合同自带完整 verification 资产，无 claim/staging 残留', async () => {
    const src = makeSourceDir();
    const audit = { write: vi.fn(), message: (s: string) => s } as never;

    await contractCreateFromDirCommand(
      { fsFactory, contractSystem: makeManager() },
      'alice',
      src,
      { audit },
    );

    const contracts = fs.readdirSync(path.join(clawDir, 'contract', 'active'));
    expect(contracts).toHaveLength(1);
    const root = activeDirOf(contracts[0]);
    // 资产随 publish 一致可见；白名单外文件被过滤
    expect(fs.readFileSync(path.join(root, 'verification', 'check.sh'), 'utf-8')).toContain('exit 0');
    expect(fs.readFileSync(path.join(root, 'verification', 'notes.md'), 'utf-8')).toBe('# notes\n');
    expect(fs.existsSync(path.join(root, 'verification', 'evil.exe'))).toBe(false);
    // 无 claim / staging 残留
    expect(fs.existsSync(path.join(root, CREATION_CLAIM_FILE))).toBe(false);
    expect(fs.existsSync(path.join(root, CREATION_ASSETS_STAGING_DIR))).toBe(false);
  });

  it('崩溃窗口：claim + 完整 staging → recoverCreation 完成资产落位并 publish', async () => {
    const manager = makeManager();
    const contractId = makeContractId('asset-recover');
    const contract = makeContractYaml({
      id: contractId,
      title: 'Recover',
      goal: 'Recover',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });
    const assets = [{ name: 'check.sh', content: '#!/bin/sh\nexit 0\n' }];
    const intent = buildCreationIntent(contract, contractId, new Date().toISOString(), assets);

    // 手工构造崩溃窗口：claim + 完整 staging，未 materialize/publish
    const root = activeDirOf(contractId);
    fs.mkdirSync(path.join(root, CREATION_ASSETS_STAGING_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, CREATION_CLAIM_FILE), serializeCreationIntent(intent));
    fs.writeFileSync(path.join(root, CREATION_ASSETS_STAGING_DIR, 'check.sh'), assets[0].content);

    expect(await manager.recoverCreation(contractId)).toBe('recovered');

    expect(fs.existsSync(path.join(root, CREATION_CLAIM_FILE))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'verification', 'check.sh'), 'utf-8')).toBe(assets[0].content);
    expect(fs.existsSync(path.join(root, CREATION_ASSETS_STAGING_DIR))).toBe(false);
  });

  it('staging 不完整（manifest 两条目、staging 只有其一）→ fail-closed，不发布、证据保留', async () => {
    const manager = makeManager();
    const contractId = makeContractId('asset-incomplete');
    const contract = makeContractYaml({
      id: contractId,
      title: 'Incomplete',
      goal: 'Incomplete',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });
    const assets = [
      { name: 'a.sh', content: 'echo a\n' },
      { name: 'b.sh', content: 'echo b\n' },
    ];
    const intent = buildCreationIntent(contract, contractId, new Date().toISOString(), assets);

    const root = activeDirOf(contractId);
    fs.mkdirSync(path.join(root, CREATION_ASSETS_STAGING_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, CREATION_CLAIM_FILE), serializeCreationIntent(intent));
    fs.writeFileSync(path.join(root, CREATION_ASSETS_STAGING_DIR, 'a.sh'), assets[0].content);
    // b.sh 缺失 —— 字节只存在于 staging，intent 是不可恢复的不完整事实

    expect(await manager.recoverCreation(contractId)).toBe('failed');

    // claim 保留（合同未发布：无 contract.yaml）；已落位的 a.sh 与缺失的 b.sh
    // 构成可核对证据（部分落位幂等：修复 staging 后可再次恢复完成 publish）
    expect(fs.existsSync(path.join(root, CREATION_CLAIM_FILE))).toBe(true);
    expect(fs.existsSync(path.join(root, 'contract.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'verification', 'b.sh'))).toBe(false);
    const aPlaced = fs.existsSync(path.join(root, 'verification', 'a.sh'));
    const aStaged = fs.existsSync(path.join(root, CREATION_ASSETS_STAGING_DIR, 'a.sh'));
    expect(aPlaced || aStaged).toBe(true); // a.sh 字节不丢失（恰好一处）
    expect(aPlaced && aStaged).toBe(false);
  });

  it('资产名越界（路径分隔符）→ 创建前 typed 拒绝，不产生 claim', async () => {
    const manager = makeManager();
    const contractId = makeContractId('asset-traversal');
    await expect(manager.create({
      contract: makeContractYaml({
        id: contractId,
        title: 'T',
        goal: 'G',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }),
      verificationAssets: [{ name: '../evil.sh', content: 'x' }],
    })).rejects.toThrow(ContractValidationError);

    expect(fs.existsSync(activeDirOf(contractId))).toBe(false);
  });

  it('已发布合同的同 id 重试仍 already_exists，winner 资产不被覆盖', async () => {
    const manager = makeManager();
    const contractId = makeContractId('asset-dup');
    const base = {
      contract: makeContractYaml({
        id: contractId,
        title: 'Winner',
        goal: 'G',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }),
    };
    await manager.create({ ...base, verificationAssets: [{ name: 'check.sh', content: 'winner\n' }] });

    await expect(
      manager.create({ ...base, verificationAssets: [{ name: 'check.sh', content: 'loser\n' }] }),
    ).rejects.toThrow(ContractValidationError);

    expect(
      fs.readFileSync(path.join(activeDirOf(contractId), 'verification', 'check.sh'), 'utf-8'),
    ).toBe('winner\n');
  });
});
