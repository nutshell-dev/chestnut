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
