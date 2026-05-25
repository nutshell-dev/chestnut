/**
 * Legacy acceptance → verification migrate audit emit (phase 1257 r134 C fork)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-legacy-acceptance-migrate-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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
  const { audit, events } = makeAudit();
  return {
    fs: nodeFs,
    audit,
    events,
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

describe('legacy acceptance → verification migrate (phase 1257 r134 C fork)', () => {
  it('reverse 1: yaml with acceptance field → migrate + audit emit', async () => {
    const contractId = 'legacy-acceptance-emit';
    const yamlContent = [
      'title: Legacy Contract',
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
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_LEGACY_ACCEPTANCE_FIELD)).toBe(true);
    const emitEvent = ctx.events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_LEGACY_ACCEPTANCE_FIELD);
    expect(emitEvent).toContain(`contractId=${contractId}`);
    expect(emitEvent).toContain('field=acceptance');
  });

  it('reverse 2: yaml with verification field (no acceptance) → 0 emit', async () => {
    const contractId = 'new-verification-no-emit';
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
    expect(ctx.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_LEGACY_ACCEPTANCE_FIELD).length).toBe(0);
  });

  it('reverse 3: yaml with neither field → 0 emit + verification field absent', async () => {
    const contractId = 'neither-field';
    const yamlContent = [
      'title: Minimal Contract',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result.verification).toBeUndefined();
    expect(ctx.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_LEGACY_ACCEPTANCE_FIELD).length).toBe(0);
  });
});
