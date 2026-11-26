/**
 * phase 1879 Step C: resolveSubagentRunDir（SubAgent 两命名空间存在性归 owner）。
 *
 * 语义（与迁移前 CLI resolveResultDir 的 sync/legacy 段逐语义等价）：
 * - sync（tasks/sync/subagent）优先、legacy（tasks/subagents）次之；
 * - 首个命中返回 clawDir 相对路径；全部未命中 → null；
 * - 只读、无写副作用。
 */
import { afterEach, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  createSubagentExecutionStore,
  prepareSubagentInput,
  querySubagentExecution,
  resolveSubagentRunDir,
  type SubagentJsonValue,
} from '../../../src/core/subagent/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const ID = 'verifier-c1-s1';

function makeExistsFs(existing: ReadonlySet<string>) {
  const seen: string[] = [];
  return {
    seen,
    existsSync: (p: string): boolean => {
      seen.push(p);
      return existing.has(p);
    },
  };
}

describe('phase 1879 Step C: resolveSubagentRunDir（owner 两命名空间查询）', () => {
  it('sync 命中优先（不再探测 legacy）', () => {
    const fsImpl = makeExistsFs(new Set([
      `tasks/sync/subagent/${ID}`,
      `tasks/subagents/${ID}`,
    ]));
    expect(resolveSubagentRunDir(fsImpl, ID)).toBe(`tasks/sync/subagent/${ID}`);
    expect(fsImpl.seen).toEqual([`tasks/sync/subagent/${ID}`]);
  });

  it('sync 未命中 → legacy 回落', () => {
    const fsImpl = makeExistsFs(new Set([`tasks/subagents/${ID}`]));
    expect(resolveSubagentRunDir(fsImpl, ID)).toBe(`tasks/subagents/${ID}`);
    expect(fsImpl.seen).toEqual([`tasks/sync/subagent/${ID}`, `tasks/subagents/${ID}`]);
  });

  it('全部未命中 → null', () => {
    const fsImpl = makeExistsFs(new Set());
    expect(resolveSubagentRunDir(fsImpl, ID)).toBeNull();
  });
});

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
});

function legacyInput(resultDir: string, currentContractId?: string): SubagentJsonValue {
  return {
    schema_version: 1,
    kind: 'run_subagent_options',
    agentId: 'verifier-attempt-11111111-1111-1111-1111-111111111111',
    clawDir: '/tmp/contract-claw',
    syncDir: '/tmp/contract-claw/tasks/sync',
    resultDir,
    prompt: 'secret prompt must not be projected',
    systemPrompt: 'secret system prompt',
    ...(currentContractId !== undefined ? { currentContractId } : {}),
  };
}

async function seedExecution(input: (resultDir: string) => unknown, tag = 'query') {
  const root = await createTrackedTempDir(`chestnut-phase2249-${tag}-`);
  tempDirs.push(root);
  const clawDir = path.join(root, 'claw');
  await fsp.mkdir(clawDir, { recursive: true });
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const location = {
    runId: 'verifier-attempt-11111111-1111-1111-1111-111111111111',
    resultDir: 'tasks/sync/subagent/verifier-attempt-11111111-1111-1111-1111-111111111111',
  };
  const store = createSubagentExecutionStore({
    fs,
    resultDir: location.resultDir,
    newAttemptId: () => 'physical-attempt-1',
    now: () => 1_700_000_000_000,
  });
  const prepared = await store.prepareInput(location, input(location.resultDir));
  const claimed = await store.claimAttempt({
    location,
    inputDigest: prepared.document.inputDigest,
    ordinal: 1,
    parentAttemptId: null,
    startBasis: 'start',
  });
  if (claimed.kind !== 'claimed') throw new Error('expected a new execution claim');
  await claimed.writer.transition({ state: 'prepared' });
  await claimed.writer.transition({ state: 'running' });
  return { root, clawDir, fs, location };
}

async function snapshot(root: string, relative = '.'): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, child));
    else if (entry.isFile()) {
      const bytes = await fsp.readFile(path.join(root, child));
      result[child.split(path.sep).join('/')] = createHash('sha256').update(bytes).digest('hex');
    }
  }
  return result;
}

describe('Phase 2249 Step D: persisted execution correlation projection', () => {
  it('V12/V13: returns only a known currentContractId and repeats without any writes', async () => {
    const f = await seedExecution(resultDir => legacyInput(resultDir, 'contract-a'), 'known');
    const before = await snapshot(f.clawDir);
    const first = await querySubagentExecution(f.fs, f.location);
    const second = await querySubagentExecution(f.fs, f.location);
    expect(first).toMatchObject({
      kind: 'found',
      view: { state: 'running' },
      correlation: { kind: 'known', currentContractId: 'contract-a' },
    });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('input');
    expect(JSON.stringify(first)).not.toContain('secret prompt');
    expect(await snapshot(f.clawDir)).toEqual(before);
    expect(await fsp.readdir(path.join(f.clawDir, f.location.resultDir, 'execution/attempts'))).toEqual(['1']);
  });

  it('V13: distinguishes a supported absent field from unavailable input shapes', async () => {
    const registry = new ToolRegistryImpl();
    const cases: Array<{ name: string; input: (resultDir: string) => unknown; correlation: object }> = [
      { name: 'legacy absent', input: resultDir => legacyInput(resultDir), correlation: { kind: 'absent' } },
      {
        name: 'prepared absent',
        input: () => prepareSubagentInput({
          prompt: 'prepared input', tools: { manifest: registry.freeze() },
        }),
        correlation: { kind: 'absent' },
      },
      {
        name: 'bad field type',
        input: resultDir => ({ ...legacyInput(resultDir), currentContractId: 42 }),
        correlation: { kind: 'unavailable', reason: 'currentContractId is not a non-empty string' },
      },
      {
        name: 'blank field',
        input: resultDir => ({ ...legacyInput(resultDir, 'contract-a'), currentContractId: '  ' }),
        correlation: { kind: 'unavailable', reason: 'currentContractId is not a non-empty string' },
      },
      {
        name: 'unknown version',
        input: resultDir => ({ ...legacyInput(resultDir, 'contract-a'), schema_version: 2 }),
        correlation: { kind: 'unavailable', reason: 'unsupported execution input schema version' },
      },
      {
        name: 'unknown kind',
        input: resultDir => ({ ...legacyInput(resultDir, 'contract-a'), kind: 'future_input' }),
        correlation: { kind: 'unavailable', reason: 'unsupported execution input kind' },
      },
      {
        name: 'invalid prepared shape',
        input: () => ({ schema_version: 1, kind: 'prepared_subagent_input', prompt: 'incomplete' }),
        correlation: { kind: 'unavailable', reason: 'prepared execution input is invalid' },
      },
    ];
    for (const testCase of cases) {
      const f = await seedExecution(testCase.input, `case-${testCase.name.replaceAll(' ', '-')}`);
      const observation = await querySubagentExecution(f.fs, f.location);
      expect(observation, testCase.name).toMatchObject({ kind: 'found', correlation: testCase.correlation });
      expect(observation, testCase.name).not.toHaveProperty('input');
    }
  });

  it('V13: a digest mismatch remains corrupt instead of producing trusted correlation', async () => {
    const f = await seedExecution(resultDir => legacyInput(resultDir, 'contract-a'), 'bad-digest');
    const inputPath = path.join(f.clawDir, f.location.resultDir, 'execution/input.json');
    const document = JSON.parse(await fsp.readFile(inputPath, 'utf8'));
    document.input.currentContractId = 'contract-b';
    await fsp.writeFile(inputPath, JSON.stringify(document));
    const before = await snapshot(f.clawDir);

    const observation = await querySubagentExecution(f.fs, f.location);
    expect(observation).toMatchObject({ kind: 'corrupt' });
    expect(observation).not.toHaveProperty('correlation');
    expect(await snapshot(f.clawDir)).toEqual(before);
  });

  it('V13: an envelope identity mismatch remains corrupt without a fallback to the directory name', async () => {
    const f = await seedExecution(resultDir => legacyInput(resultDir, 'contract-a'), 'bad-identity');
    const inputPath = path.join(f.clawDir, f.location.resultDir, 'execution/input.json');
    const document = JSON.parse(await fsp.readFile(inputPath, 'utf8'));
    document.runId = 'verifier-other';
    await fsp.writeFile(inputPath, JSON.stringify(document));
    const before = await snapshot(f.clawDir);

    const observation = await querySubagentExecution(f.fs, f.location);
    expect(observation).toMatchObject({ kind: 'corrupt' });
    expect(observation).not.toHaveProperty('correlation');
    expect(await snapshot(f.clawDir)).toEqual(before);
  });
});
