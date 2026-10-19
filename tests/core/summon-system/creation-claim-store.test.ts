/**
 * Phase 1396 Step B: SummonCreationClaimStore tests.
 *
 * 0/1 不变量（Phase 1396 总览 §4）：
 * - fresh claim → 'claimed' + durable persist
 * - 同候选重试 → 'same_claim'（幂等）
 * - 不同候选（contractId 或 targetExecutorId 不同）→ SummonContractAlreadyClaimedError
 * - 损坏 claim → SummonCreationClaimCorruptedError（不静默覆盖）
 * - 并发双 claim → 恰好一个 winner
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  createSummonCreationClaimStore,
  SummonContractAlreadyClaimedError,
  SummonCreationClaimCorruptedError,
  SUMMON_CREATION_CLAIMS_DIR,
  SUMMON_CREATION_CLAIM_FILE,
  SUMMON_CREATION_CLAIM_STAGING_PREFIX,
  SUMMON_CLAIM_STAGING_ORPHAN_AGE_MS,
  type SummonCreationClaimStore,
} from '../../../src/core/summon-system/creation-claim-store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('SummonCreationClaimStore (phase 1396 Step B)', () => {
  let tempDir: string;
  let store: SummonCreationClaimStore;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `summon-claim-store-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = createSummonCreationClaimStore({ fs: new NodeFileSystem({ baseDir: tempDir }) });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  const claimPath = (summonId: string): string =>
    path.join(tempDir, SUMMON_CREATION_CLAIMS_DIR, summonId, SUMMON_CREATION_CLAIM_FILE);

  it('fresh claim → claimed + durable persist + read round-trip', async () => {
    const result = await store.claim({
      summonId: 's-1',
      targetExecutorId: 'claw-a',
      contractId: 'c-1',
    });

    expect(result.kind).toBe('claimed');
    expect(result.claim).toMatchObject({
      schema_version: 1,
      summonId: 's-1',
      targetExecutorId: 'claw-a',
      contractId: 'c-1',
    });
    expect(typeof result.claim.claimedAt).toBe('string');

    const persisted = JSON.parse(await fs.readFile(claimPath('s-1'), 'utf-8'));
    expect(persisted).toEqual(result.claim);

    const read = await store.read('s-1');
    expect(read).toEqual(result.claim);
  });

  it('same candidate retry → same_claim, preserves original claimedAt', async () => {
    const first = await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });
    const second = await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });

    expect(second.kind).toBe('same_claim');
    expect(second.claim).toEqual(first.claim);
  });

  it('different contractId candidate → SummonContractAlreadyClaimedError', async () => {
    await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });

    const err = await store
      .claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-2' })
      .catch(e => e);
    expect(err).toBeInstanceOf(SummonContractAlreadyClaimedError);
    expect(err.existing).toMatchObject({ summonId: 's-1', contractId: 'c-1' });
    expect(err.requested).toMatchObject({ summonId: 's-1', contractId: 'c-2' });

    // 原 claim 不被覆盖
    const read = await store.read('s-1');
    expect(read?.contractId).toBe('c-1');
  });

  it('different targetExecutorId candidate → SummonContractAlreadyClaimedError', async () => {
    await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });

    await expect(
      store.claim({ summonId: 's-1', targetExecutorId: 'claw-b', contractId: 'c-1' }),
    ).rejects.toBeInstanceOf(SummonContractAlreadyClaimedError);
  });

  it('different summonId is an independent claim scope', async () => {
    await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });
    const other = await store.claim({ summonId: 's-2', targetExecutorId: 'claw-a', contractId: 'c-9' });
    expect(other.kind).toBe('claimed');
  });

  it('read missing → undefined', async () => {
    await expect(store.read('missing')).resolves.toBeUndefined();
  });

  it('corrupt claim → read throws SummonCreationClaimCorruptedError', async () => {
    await fs.mkdir(path.dirname(claimPath('s-1')), { recursive: true });
    await fs.writeFile(claimPath('s-1'), 'not-json{{{');

    await expect(store.read('s-1')).rejects.toBeInstanceOf(SummonCreationClaimCorruptedError);
  });

  it('corrupt claim → claim throws corrupted instead of overwriting', async () => {
    await fs.mkdir(path.dirname(claimPath('s-1')), { recursive: true });
    await fs.writeFile(claimPath('s-1'), JSON.stringify({ schema_version: 99 }));

    await expect(
      store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' }),
    ).rejects.toBeInstanceOf(SummonCreationClaimCorruptedError);

    // 未被覆盖
    const raw = await fs.readFile(claimPath('s-1'), 'utf-8');
    expect(JSON.parse(raw).schema_version).toBe(99);
  });

  it('concurrent double claim → exactly one claimed + one same_claim', async () => {
    const input = { summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' };
    const results = await Promise.all([store.claim(input), store.claim(input)]);

    const kinds = results.map(r => r.kind).sort();
    expect(kinds).toEqual(['claimed', 'same_claim']);
    expect(results[0].claim).toEqual(results[1].claim);

    // 只有一个持久文件且内容与 winner 一致
    const persisted = JSON.parse(await fs.readFile(claimPath('s-1'), 'utf-8'));
    expect(persisted).toEqual(results[0].claim);
  });

  it('unsafe summonId → fail-closed', async () => {
    await expect(
      store.claim({ summonId: '../escape', targetExecutorId: 'claw-a', contractId: 'c-1' }),
    ).rejects.toThrow(/Invalid summon id/);
    await expect(store.read('../escape')).rejects.toThrow(/Invalid summon id/);
  });
});

describe('SummonCreationClaimStore read-side identity binding (Phase 1908 Step E)', () => {
  let tempDir: string;
  let store: SummonCreationClaimStore;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `summon-claim-binding-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = createSummonCreationClaimStore({ fs: new NodeFileSystem({ baseDir: tempDir }) });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  const writeClaimFile = async (dirSummonId: string, claim: Record<string, unknown>): Promise<void> => {
    const dir = path.join(tempDir, SUMMON_CREATION_CLAIMS_DIR, dirSummonId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, SUMMON_CREATION_CLAIM_FILE), JSON.stringify(claim, null, 2));
  };

  const mismatchedClaim = (contentSummonId: string): Record<string, unknown> => ({
    schema_version: 1,
    summonId: contentSummonId,
    targetExecutorId: 'claw-a',
    contractId: 'c-1',
    claimedAt: new Date().toISOString(),
  });

  it('read: 路径 key 与内容 summonId 错配 → SummonCreationClaimCorruptedError（fail-closed）', async () => {
    await writeClaimFile('s-dir', mismatchedClaim('s-other'));

    await expect(store.read('s-dir')).rejects.toThrow(SummonCreationClaimCorruptedError);
    // 证据保留：文件不被改写/删除
    const raw = await fs.readFile(
      path.join(tempDir, SUMMON_CREATION_CLAIMS_DIR, 's-dir', SUMMON_CREATION_CLAIM_FILE),
      'utf-8',
    );
    expect(JSON.parse(raw).summonId).toBe('s-other');
  });

  it('read: 路径 key 与内容 summonId 一致 → 正常返回', async () => {
    await writeClaimFile('s-dir', mismatchedClaim('s-dir'));
    const claim = await store.read('s-dir');
    expect(claim?.summonId).toBe('s-dir');
    expect(claim?.contractId).toBe('c-1');
  });

  it('list: 目录名与内容 summonId 错配 → 进 unreadable，不进 claims', async () => {
    await writeClaimFile('s-good', mismatchedClaim('s-good'));
    await writeClaimFile('s-bad', mismatchedClaim('s-other'));

    const listing = await store.list();
    expect(listing.readable).toBe(true);
    expect(listing.claims.map(c => c.summonId)).toEqual(['s-good']);
    expect(listing.unreadable).toHaveLength(1);
    expect(listing.unreadable[0].summonId).toBe('s-bad');
    expect(listing.unreadable[0].detail).toContain('does not match path key');
  });

  it('claim(EEXIST 比较): 已有测试覆盖同候选幂等/异候选拒绝 —— 错配内容经 read 面 fail-closed 不回归', async () => {
    const result = await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });
    expect(result.kind).toBe('claimed');
    const retry = await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });
    expect(retry.kind).toBe('same_claim');
  });
});

/**
 * Phase 1948 Step B：staging + link 原子发布与崩溃残留 sweep。
 *
 * 根因回归钉：writeExclusive 直发会让 claim 路径在内容写完前可见，并发 loser
 * 观察到空/半写文件；现 claim 路径首次可见即完整（linkExclusiveSync 原子 no-replace）。
 * - 确定性并发：BarrierFs 暂停首个 staging 写入 ⇒ claim 路径不存在；第二 contender
 *   完成 link 成为 winner；被暂停者 EEXIST → 读到完整 claim → same_claim（不依赖重读窗口）。
 * - 正常路径 staging 清理（成功与 EEXIST 同路径）。
 * - sweepStaging：stale staging 删除 / fresh staging 保留 / claim（即使老旧）保留；
 *   单项失败进 failures 不 throw。
 */

/** 暂停首个 staging writeExclusive 的确定性并发门控（signal + release）。 */
class BarrierFs extends NodeFileSystem {
  private armed = true;
  private arrivedResolve!: () => void;
  readonly arrived = new Promise<void>(resolve => { this.arrivedResolve = resolve; });
  private releaseResolve!: () => void;
  private readonly releaseGate = new Promise<void>(resolve => { this.releaseResolve = resolve; });

  override async writeExclusive(relativePath: string, content: string): Promise<void> {
    if (this.armed && relativePath.includes(SUMMON_CREATION_CLAIM_STAGING_PREFIX)) {
      this.armed = false;
      this.arrivedResolve();
      await this.releaseGate;
    }
    await super.writeExclusive(relativePath, content);
  }

  release(): void {
    this.releaseResolve();
  }
}

describe('SummonCreationClaimStore staging 原子发布 + sweep (Phase 1948 Step B)', () => {
  let tempDir: string;
  let store: SummonCreationClaimStore;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tempDir = path.join(tmpdir(), `summon-claim-staging-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = createSummonCreationClaimStore({ fs: new NodeFileSystem({ baseDir: tempDir }) });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  const summonDir = (summonId: string): string =>
    path.join(tempDir, SUMMON_CREATION_CLAIMS_DIR, summonId);
  const claimAbsPath = (summonId: string): string =>
    path.join(summonDir(summonId), SUMMON_CREATION_CLAIM_FILE);
  const listStaging = async (summonId: string): Promise<string[]> =>
    (await fs.readdir(summonDir(summonId)).catch(() => [] as string[]))
      .filter(name => name.startsWith(SUMMON_CREATION_CLAIM_STAGING_PREFIX));

  const validClaimRaw = (summonId: string): string =>
    JSON.stringify({
      schema_version: 1,
      summonId,
      targetExecutorId: 'claw-a',
      contractId: 'c-1',
      claimedAt: new Date().toISOString(),
    }, null, 2);

  it('确定性并发：staging 暂停期间 claim 路径不可见；先 link 者 claimed，后者 EEXIST→same_claim', async () => {
    const barrierFs = new BarrierFs({ baseDir: tempDir });
    const barrierStore = createSummonCreationClaimStore({ fs: barrierFs });
    const input = { summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' };

    const firstPromise = barrierStore.claim(input);
    await barrierFs.arrived;

    // 根因钉：staging 写入被暂停 ⇒ claim 路径尚不存在（旧实现此处路径已可见但内容为空）
    await expect(barrierStore.read('s-1')).resolves.toBeUndefined();

    // 第二 contender 不受门控：完整走完 staging + link，赢得 claim
    const second = await barrierStore.claim(input);
    expect(second.kind).toBe('claimed');

    barrierFs.release();
    const first = await firstPromise;
    expect(first.kind).toBe('same_claim');
    expect(first.claim).toEqual(second.claim);

    // claim 内容完整持久，双方 staging 均已清理
    const persisted = JSON.parse(await fs.readFile(claimAbsPath('s-1'), 'utf-8'));
    expect(persisted).toEqual(second.claim);
    expect(await listStaging('s-1')).toEqual([]);
  });

  it('正常路径：成功 claim 后 staging 被清理，只留下 creation-claim.json', async () => {
    const result = await store.claim({ summonId: 's-1', targetExecutorId: 'claw-a', contractId: 'c-1' });
    expect(result.kind).toBe('claimed');

    const names = await fs.readdir(summonDir('s-1'));
    expect(names).toEqual([SUMMON_CREATION_CLAIM_FILE]);
  });

  it('sweepStaging：stale staging 删除，fresh staging 保留，老旧 claim 保留', async () => {
    await fs.mkdir(summonDir('s-stale'), { recursive: true });
    const stale = path.join(summonDir('s-stale'), `${SUMMON_CREATION_CLAIM_STAGING_PREFIX}stale-token`);
    const fresh = path.join(summonDir('s-stale'), `${SUMMON_CREATION_CLAIM_STAGING_PREFIX}fresh-token`);
    await fs.writeFile(stale, '{}');
    await fs.writeFile(fresh, '{}');
    await fs.writeFile(claimAbsPath('s-stale'), validClaimRaw('s-stale'));
    const past = new Date(Date.now() - 2 * SUMMON_CLAIM_STAGING_ORPHAN_AGE_MS);
    // staging 与 claim 同样老旧：只有前缀匹配的 staging 允许被删
    await fs.utimes(stale, past, past);
    await fs.utimes(claimAbsPath('s-stale'), past, past);

    const result = await store.sweepStaging();
    expect(result).toEqual({ cleaned: 1, failures: [] });

    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(claimAbsPath('s-stale'))).resolves.toBeUndefined();
    // claim 仍可正常读回（sweep 未动其内容）
    const read = await store.read('s-stale');
    expect(read?.summonId).toBe('s-stale');
  });

  it('sweepStaging：claims 根目录不存在 → 空结果，不 throw', async () => {
    await expect(store.sweepStaging()).resolves.toEqual({ cleaned: 0, failures: [] });
  });

  it('sweepStaging：单项 delete 失败进 failures，不 throw，文件保留', async () => {
    class DeleteFailFs extends NodeFileSystem {
      override async delete(relativePath: string): Promise<void> {
        if (relativePath.includes(SUMMON_CREATION_CLAIM_STAGING_PREFIX)) {
          throw Object.assign(new Error('boom'), { code: 'EACCES' });
        }
        await super.delete(relativePath);
      }
    }
    const failStore = createSummonCreationClaimStore({ fs: new DeleteFailFs({ baseDir: tempDir }) });
    await fs.mkdir(summonDir('s-fail'), { recursive: true });
    const stale = path.join(summonDir('s-fail'), `${SUMMON_CREATION_CLAIM_STAGING_PREFIX}stuck-token`);
    await fs.writeFile(stale, '{}');
    const past = new Date(Date.now() - 2 * SUMMON_CLAIM_STAGING_ORPHAN_AGE_MS);
    await fs.utimes(stale, past, past);

    const result = await failStore.sweepStaging();
    expect(result.cleaned).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].summonId).toBe('s-fail');
    expect(result.failures[0].detail).toContain('boom');

    // 失败不吞没也不误删：文件仍在，留给下次 sweep
    await expect(fs.access(stale)).resolves.toBeUndefined();
  });
});
