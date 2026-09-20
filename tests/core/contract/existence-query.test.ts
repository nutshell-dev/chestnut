/**
 * Phase 1872 Step E: queryContractExistence —— 存在性只读查询（0-instance-dep）。
 *
 * 语义与 ContractSystem.hasContract 等价（同一 resolveContractLocation 底层）：
 * - active 根存在且已发布（无 .creating marker）→ true；带 marker（未发布）→ false；
 * - archive/<state>/<id> 当前态 / legacy flat archive/<id> → true；
 * - 全无 → false；多位置歧义 → 重试一次后抛 ContractLocationAmbiguityError（不折 false）。
 * 只读：无写副作用。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { queryContractExistence } from '../../../src/core/contract/index.js';
import { resolveContractLocation } from '../../../src/core/contract/locations.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_ARCHIVE_DIR } from '../../../src/core/contract/dirs.js';
import { makeArchiveDir } from '../../../src/core/contract/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

const CONTRACT_ID = '1700000000000-abcd';

describe('phase 1872 Step E: queryContractExistence', () => {
  let rootDir: string;
  let fsImpl: NodeFileSystem;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    rootDir = path.join(os.tmpdir(), `contract-existence-${randomUUID()}`);
    fs.mkdirSync(rootDir, { recursive: true });
    fsImpl = new NodeFileSystem({ baseDir: rootDir });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function mkdir(rel: string): void {
    fs.mkdirSync(path.join(rootDir, rel), { recursive: true });
  }

  it('active 发布态（无 .creating）→ true', async () => {
    mkdir(`${CONTRACT_ACTIVE_DIR}/${CONTRACT_ID}`);
    expect(await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID))).toBe(true);
  });

  it('active 带 .creating marker（未发布）→ false', async () => {
    mkdir(`${CONTRACT_ACTIVE_DIR}/${CONTRACT_ID}`);
    fs.writeFileSync(path.join(rootDir, CONTRACT_ACTIVE_DIR, CONTRACT_ID, '.creating'), '{}');
    expect(await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID))).toBe(false);
  });

  it('archive 当前态（各 state 容器）→ true', async () => {
    for (const state of ['completed', 'failed', 'cancelled']) {
      const dir = path.join(rootDir, CONTRACT_ARCHIVE_DIR, state, CONTRACT_ID);
      fs.mkdirSync(dir, { recursive: true });
      expect(await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID))).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy flat archive/<id> → true', async () => {
    mkdir(`${CONTRACT_ARCHIVE_DIR}/${CONTRACT_ID}`);
    expect(await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID))).toBe(true);
  });

  it('全无 → false', async () => {
    expect(await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID))).toBe(false);
  });

  it('多位置歧义（active + archive）→ 重试后抛错，不折 false', async () => {
    mkdir(`${CONTRACT_ACTIVE_DIR}/${CONTRACT_ID}`);
    mkdir(`${CONTRACT_ARCHIVE_DIR}/completed/${CONTRACT_ID}`);
    await expect(queryContractExistence(fsImpl, makeContractId(CONTRACT_ID)))
      .rejects.toThrow(/ambigu|multi|multiple/i);
  });

  it('判定与 resolveContractLocation 等价（同底层 helper，两态对照）', async () => {
    mkdir(`${CONTRACT_ACTIVE_DIR}/${CONTRACT_ID}`);
    const viaQuery = await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID));
    const viaResolve = await resolveContractLocation({
      fs: fsImpl,
      activeDir: CONTRACT_ACTIVE_DIR,
      archiveDir: makeArchiveDir(CONTRACT_ARCHIVE_DIR),
      contractId: makeContractId(CONTRACT_ID),
    });
    expect(viaQuery).toBe(viaResolve !== null);
    expect(viaQuery).toBe(true);
  });

  it('只读：查询前后目录树不变', async () => {
    mkdir(`${CONTRACT_ACTIVE_DIR}/${CONTRACT_ID}`);
    const before = JSON.stringify(fs.readdirSync(path.join(rootDir, 'contract')));
    await queryContractExistence(fsImpl, makeContractId(CONTRACT_ID));
    await queryContractExistence(fsImpl, makeContractId('other-id'));
    const after = JSON.stringify(fs.readdirSync(path.join(rootDir, 'contract')));
    expect(after).toBe(before);
  });

  it('反向：assembly 的 summonContractQuery.exists 路径不再构造业务实例', () => {
    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/assembly/business-systems.ts'),
      'utf-8',
    );
    const start = src.indexOf('const summonContractQuery');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('};', start);
    const block = src.slice(start, end);
    expect(block).not.toContain('createContractSystem');
    expect(block).not.toContain('createSystemAudit');
    expect(block).not.toContain('createClawNotifier');
    expect(block).toContain('queryContractExistence');
  });
});
