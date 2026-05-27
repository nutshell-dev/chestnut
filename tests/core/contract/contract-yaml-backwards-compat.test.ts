/**
 * Backwards-compat transform for loadContractYaml:
 * old `acceptance` field → new `verification` field
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-backwards-compat-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function makeCtx(contractId: string) {
  return {
    fs: nodeFs,
    audit: makeMockAudit() as any,
    contractDir: async () => 'contract/active',
    getProgress: async () =>
      ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
  };
}

async function writeContractYaml(contractId: string, yamlContent: string) {
  const contractDir = path.join(clawDir, 'contract', 'active', contractId);
  await fs.mkdir(contractDir, { recursive: true });
  await fs.writeFile(
    path.join(contractDir, 'contract.yaml'),
    yamlContent,
    'utf-8',
  );
  await fs.writeFile(
    path.join(contractDir, 'progress.json'),
    JSON.stringify({ contract_id: contractId, status: 'running', subtasks: {} }),
    'utf-8',
  );
}

describe('loadContractYaml backwards-compat: acceptance → verification', () => {
  it('treats old `acceptance` array as `verification` when `verification` is absent', async () => {
    const contractId = 'old-acceptance';
    const yamlContent = [
      'title: Old Contract',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
      'acceptance:',
      "  - subtask_id: 't1'",
      "    type: 'llm'",
      '    prompt_file: verification/t1.prompt.txt',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result.verification).toEqual([
      { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
    ]);
    expect((result as any).acceptance).toBeUndefined();
  });

  it('uses `verification` directly when present', async () => {
    const contractId = 'new-verification';
    const yamlContent = [
      'title: New Contract',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
      'verification:',
      "  - subtask_id: 't1'",
      "    type: 'script'",
      '    script_file: verify.sh',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result.verification).toEqual([
      { subtask_id: 't1', type: 'script', script_file: 'verify.sh' },
    ]);
    expect((result as any).acceptance).toBeUndefined();
  });

  it('prefers `verification` over `acceptance` when both are present', async () => {
    const contractId = 'both-fields';
    const yamlContent = [
      'title: Both Fields Contract',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
      'acceptance:',
      "  - subtask_id: 't1'",
      "    type: 'llm'",
      '    prompt_file: old/t1.prompt.txt',
      'verification:',
      "  - subtask_id: 't1'",
      "    type: 'script'",
      '    script_file: new_verify.sh',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result.verification).toEqual([
      { subtask_id: 't1', type: 'script', script_file: 'new_verify.sh' },
    ]);
    expect((result as any).acceptance).toBeUndefined();
  });
});
