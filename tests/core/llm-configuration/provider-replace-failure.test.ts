import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  LLMConfigurationRevisionConflictError,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import {
  withYamlConfigLockAsync,
  writeYamlConfig,
} from '../../../src/foundation/config-store/index.js';
import { classifyDirFsyncError } from '../../../src/foundation/fs/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { cleanupTempDirSync, createTrackedTempDirSync } from '../../utils/temp.js';

const BARRIER_TIMEOUT_MS = 5_000; // 仅保护文件锁握手；实际等待由 EEXIST 事实触发。
const deps = { fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }) };
let projectDir: string;
let configPath: string;

function provider(model: string): SharedLLMInput['primary'] {
  return {
    provider_id: 'custom:anthropic',
    api_format: 'anthropic',
    auth_profile: 'api_key',
    api_key: '${PHASE2226_REPLACE_KEY}',
    model,
    label: 'replace-target',
    base_url: 'https://replace.example.test',
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function awaitBarrier(promise: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeEach(() => {
  projectDir = createTrackedTempDirSync('chestnut-provider-replace-failure-');
  vi.stubEnv('CHESTNUT_ROOT', projectDir);
  configPath = getLLMConfigurationPath();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirSync(projectDir);
});

describe('provider replace transaction failures', () => {
  it('竞争者实际等待真实锁后重读 revision，漂移拒绝且不覆盖持锁者写入', async () => {
    const store = createLLMConfigurationDocumentStore(deps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('before'));
    const stale = store.read();
    const holderReady = deferred();
    const releaseHolder = deferred();
    const holder = withYamlConfigLockAsync(deps, configPath, async () => {
      writeYamlConfig(deps, configPath, {
        ...stale,
        primary: { ...stale.primary, model: 'lock-winner' },
        revision: 2,
      });
      holderReady.resolve();
      await releaseHolder.promise;
    });
    await awaitBarrier(holderReady.promise, 'holder ready');
    const winnerBytes = fs.readFileSync(configPath, 'utf8');
    const competitorWaiting = deferred();
    const competitorDeps = {
      fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
        override writeExclusiveSync(relativePath: string, content: string): void {
          try {
            super.writeExclusiveSync(relativePath, content);
          } catch (error) {
            if (this.resolve(relativePath) === `${configPath}.lock`
              && (error as NodeJS.ErrnoException).code === 'EEXIST') {
              competitorWaiting.resolve();
            }
            throw error;
          }
        }
      })({ baseDir }),
    };
    const competitor = createLLMConfigurationDocumentStore(competitorDeps);
    const staleCommit = competitor.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...stale.primary, model: 'stale-loser' },
      stale.revision,
    );
    try {
      await awaitBarrier(competitorWaiting.promise, 'competitor lock wait');
    } finally {
      releaseHolder.resolve();
    }
    await holder;
    const conflict = await staleCommit.catch(error => error);

    expect(conflict).toBeInstanceOf(LLMConfigurationRevisionConflictError);
    expect(conflict).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(winnerBytes);
    expect(store.read()).toMatchObject({ revision: 2, primary: { model: 'lock-winner' } });
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
  });

  it('写前异常保留原错误、旧 bytes/revision，并可用新提交证明锁已恢复', async () => {
    const fault = Object.assign(new Error('injected replace pre-write failure'), { code: 'ENOSPC' });
    let armed = false;
    let calls = 0;
    const faultDeps = {
      fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
        override writeAtomicSync(relativePath: string, content: string) {
          if (armed && this.resolve(relativePath) === configPath) {
            calls += 1;
            throw fault;
          }
          return super.writeAtomicSync(relativePath, content);
        }
      })({ baseDir }),
    };
    const store = createLLMConfigurationDocumentStore(faultDeps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('before'));
    const before = store.read();
    const beforeBytes = fs.readFileSync(configPath, 'utf8');
    armed = true;

    const failure = await store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...before.primary, model: 'must-not-commit' },
      before.revision,
    ).catch(error => error);

    expect(failure).toBe(fault);
    expect(calls).toBe(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeBytes);
    expect(store.readRevision()).toEqual({ id: '1', revision: 1 });
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);

    armed = false;
    const recovered = await store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...before.primary, model: 'after-pre-write-failure' },
      before.revision,
    );
    expect(recovered.revision).toEqual({ id: '2', revision: 2 });
    expect(createLLMConfigurationDocumentStore(deps).read()).toEqual(recovered.document);
  });

  it.each([
    { code: 'EPERM', kind: 'committed_platform_limited' },
    { code: 'EIO', kind: 'committed_durability_unknown' },
  ] as const)('真实写入后交付 $kind，回执和新实例读取均不伪报零写', async scenario => {
    const fault = Object.assign(new Error(`injected ${scenario.code} after commit`), {
      code: scenario.code,
    });
    let armed = false;
    let calls = 0;
    const faultDeps = {
      fsFactory: (baseDir: string) => new (class extends NodeFileSystem {
        override writeAtomicSync(relativePath: string, content: string) {
          const actual = super.writeAtomicSync(relativePath, content);
          if (armed && this.resolve(relativePath) === configPath) {
            calls += 1;
            return classifyDirFsyncError(fault);
          }
          return actual;
        }
      })({ baseDir }),
    };
    const store = createLLMConfigurationDocumentStore(faultDeps);
    await store.commitExplicitProvider({ kind: 'initialize' }, provider('before'));
    const before = store.read();
    armed = true;

    const committed = await store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...before.primary, model: `committed-${scenario.code}` },
      before.revision,
    );

    expect(calls).toBe(1);
    expect(committed.write).toEqual({ kind: scenario.kind, error: fault });
    expect(committed.revision).toEqual({ id: '2', revision: 2 });
    expect(committed.document.primary.model).toBe(`committed-${scenario.code}`);
    expect(createLLMConfigurationDocumentStore(deps).read()).toEqual(committed.document);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);

    const recovered = await store.commitExplicitProvider(
      { kind: 'replace', slot: { role: 'primary' } },
      { ...committed.document.primary, model: `recovered-${scenario.code}` },
      committed.revision.revision,
    );
    expect(recovered.revision).toEqual({ id: '3', revision: 3 });
    expect(store.read().primary.model).toBe(`recovered-${scenario.code}`);
  });
});
