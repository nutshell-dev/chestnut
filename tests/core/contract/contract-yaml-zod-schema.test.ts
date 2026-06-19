/**
 * Phase 311 — ContractYaml Zod SoT migration tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    `.test-contract-yaml-zod-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

function makeCtx(contractId: string, options: { markCrashed?: boolean } = {}) {
  const { audit, events } = makeAudit();
  return {
    fs: nodeFs,
    audit,
    events,
    contractDir: async () => 'contract/active',
    getProgress: async () =>
      ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    markCrashed: options.markCrashed
      ? vi.fn(async (_contractId: string, _cause: string) => {})
      : undefined,
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
}

async function listCorruptedFiles(contractId: string): Promise<string[]> {
  const corruptedDir = path.join(clawDir, 'contract', 'active', contractId, 'corrupted');
  if (!await fs.stat(corruptedDir).catch(() => null)) return [];
  const entries = await fs.readdir(corruptedDir);
  return entries.filter(e => e.endsWith('.yaml'));
}

describe('ContractYaml Zod schema (phase 311)', () => {
  it('accepts valid contract.yaml', async () => {
    const contractId = 'valid-contract';
    const yamlContent = [
      'schema_version: 1',
      'title: Valid Contract',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
      'verification:',
      "  - subtask_id: 't1'",
      "    type: 'llm'",
      '    prompt_file: verification/t1.prompt.txt',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Valid Contract');
    expect(result?.goal).toBe('Test goal');
    expect(result?.subtasks).toEqual([{ id: 't1', description: 'Task 1' }]);
    expect(result?.verification).toEqual([
      { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
    ]);
  });

  it('rejects unknown field with strict() + isolates file + emits audit + markCrashed', async () => {
    const contractId = 'unknown-field';
    const yamlContent = [
      'schema_version: 1',
      'title: Unknown Field Contract',
      'goal: Test goal',
      'unknown_field: value',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId, { markCrashed: true });
    const result = await loadContractYaml(ctx, contractId);

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
    expect(ctx.markCrashed).toHaveBeenCalledWith(contractId, 'system: schema_corruption_contract_yaml');
    const corrupted = await listCorruptedFiles(contractId);
    expect(corrupted.length).toBe(1);
  });

  it('rejects missing required field (title)', async () => {
    const contractId = 'missing-title';
    const yamlContent = [
      'schema_version: 1',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
    const corrupted = await listCorruptedFiles(contractId);
    expect(corrupted.length).toBe(1);
  });

  it('rejects missing required field (goal)', async () => {
    const contractId = 'missing-goal';
    const yamlContent = [
      'schema_version: 1',
      'title: Missing Goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
  });

  it('rejects missing required field (subtasks)', async () => {
    const contractId = 'missing-subtasks';
    const yamlContent = [
      'schema_version: 1',
      'title: Missing Subtasks',
      'goal: Test goal',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
  });

  it('rejects unknown schema_version (literal(1) fail)', async () => {
    const contractId = 'unknown-version';
    const yamlContent = [
      'schema_version: 2',
      'title: Unknown Version',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
  });

  it('rejects legacy acceptance field (no silent fallback)', async () => {
    const contractId = 'legacy-acceptance';
    const yamlContent = [
      'schema_version: 1',
      'title: Legacy Acceptance',
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

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
    expect(ctx.events.some(e => e[0] === 'contract_yaml_legacy_acceptance_field')).toBe(false);
  });

  it('rejects legacy escalation.max_retries field (no silent fallback)', async () => {
    const contractId = 'legacy-escalation';
    const yamlContent = [
      'schema_version: 1',
      'title: Legacy Escalation',
      'goal: Test goal',
      'subtasks:',
      '  - id: t1',
      '    description: Task 1',
      'escalation:',
      '  max_retries: 5',
    ].join('\n');

    await writeContractYaml(contractId, yamlContent);
    const ctx = makeCtx(contractId);
    const result = await loadContractYaml(ctx, contractId);

    expect(result).toBeNull();
    expect(ctx.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID)).toBe(true);
    expect(ctx.events.some(e => e[0] === 'contract_yaml_legacy_escalation_field')).toBe(false);
  });
});
