/**
 * schema invariants merged test file (test reorganization — mechanical merge,
 * 不改任何断言逻辑)
 *
 * 本文件由以下源文件合并而来（每个源文件对应一个顶层 describe 块，内容逐字保留）:
 * 1. contract-yaml-version-invariant.test.ts
 * 2. typed-emit-invariant-cascade.test.ts
 * 3. typed-emit-invariant.test.ts
 * 4. progress-schema-version.test.ts
 * 5. acceptance-literal-invariant.test.ts
 *
 * import 合并说明: 'fs/promises' 与 'node:fs/promises' 统一为 'node:fs/promises'
 * (同一模块不同 specifier，解析结果一致)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import {
  emitContractVerifierFailed,
  emitContractVerifierSkipped,
  emitContractVerifierStarted,
  emitContractVerifierPassed,
  emitContractVerifierResultParseFailed,
} from '../../../src/core/contract/audit-emit.js';

describe('phase 311: contract.yaml schema_version invariant (Zod literal(1))', () => {
  it('rejects contract.yaml with schema_version > 1', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = path.join(os.tmpdir(), `.test-contract-version-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });

    const mockAudit = makeMockAudit();
    const contractId = 'version-test';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      'schema_version: 999\ntitle: Test\ngoal: Test\nsubtasks:\n  - id: t1\n    description: T1\n',
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    };

    const result = await loadContractYaml(ctx, contractId);
    expect(result).toBeNull();
    const calls = mockAudit.write.mock.calls;
    const versionCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID);
    expect(versionCall).toBeDefined();
    expect(versionCall).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('reason=schema_invalid'),
      ]),
    );

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('rejects contract.yaml with missing schema_version', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = path.join(os.tmpdir(), `.test-contract-missing-version-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });

    const mockAudit = makeMockAudit();
    const contractId = 'missing-version-test';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      'title: Test\ngoal: Test\nsubtasks:\n  - id: t1\n    description: T1\n',
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    };

    const result = await loadContractYaml(ctx, contractId);
    expect(result).toBeNull();
    const calls = mockAudit.write.mock.calls;
    const invalidCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID);
    expect(invalidCall).toBeDefined();

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });
});

/**
 * Phase 1267 D.1: typed emit invariant cascade lint test
 *
 * 主 sweep (`emitContract*` 含 contractId opts 必首行 guard) 已迁 ESLint custom
 * rule `chestnut-custom/typed-emit-cascade-first-line-guard` (phase 424)。
 *
 * 本 file 仅留 #2 positive presence (assertContractIdNonEmpty helper signature)
 * — ESLint 不擅长 positive contract verification。
 */
describe('phase 1267 D.1: assertContractIdNonEmpty helper signature positive (phase 424 缩 vitest)', () => {
  it('assertContractIdNonEmpty helper signature accepts string | undefined', async () => {
    const content = await fs.readFile('src/core/contract/audit-emit.ts', 'utf-8');
    expect(content).toMatch(/function assertContractIdNonEmpty\(\n  audit: AuditLog,\n  contractId: string \| undefined,/);
  });
});

describe('phase 1235 r132 B.3: typed emit empty contractId invariant', () => {
  function makeFakeAudit() {
    const writes: Array<{ event: string; cols: string[] }> = [];
    return {
      audit: { write: (event: string, ...cols: string[]) => { writes.push({ event, cols }); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
      writes,
    };
  }

  it('reverse 1: emit fn with valid contractId → no invariant violation + cols emit', () => {
    const { audit, writes } = makeFakeAudit();
    emitContractVerifierPassed(audit, { contractId: 'cid-valid-123', agentId: 'aid' });
    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe(CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED);
    expect(writes[0].cols[0]).toBe('contractId=cid-valid-123');
    expect(writes[0].cols[1]).toBe('agentId=aid');
  });

  it('reverse 2: emit fn with empty contractId → invariant emit + 0 cols emit + early return', () => {
    const { audit, writes } = makeFakeAudit();
    emitContractVerifierPassed(audit, { contractId: '', agentId: 'verifier-cid-abc-sub1' });
    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe(CONTRACT_AUDIT_EVENTS.TYPED_EMIT_INVARIANT_VIOLATION);
    expect(writes[0].cols).toContain('field=contractId');
    expect(writes[0].cols).toContain('event=emitContractVerifierPassed');
    expect(writes[0].cols).toContain('reason=empty_string');
  });

  it('reverse 3: 5 verifier emit fn 各 verify invariant 触发统一', () => {
    const checks: Array<{ name: string; emit: (audit: any) => void; expectedFnName: string }> = [
      {
        name: 'failed',
        emit: (a) => emitContractVerifierFailed(a, { contractId: '', agentId: 'aid', clawId: 'claw1', kind: 'k', reason: 'r' }),
        expectedFnName: 'emitContractVerifierFailed',
      },
      {
        name: 'skipped',
        emit: (a) => emitContractVerifierSkipped(a, { contractId: '', agentId: 'aid', reason: 'r' }),
        expectedFnName: 'emitContractVerifierSkipped',
      },
      {
        name: 'started',
        emit: (a) => emitContractVerifierStarted(a, { contractId: '', agentId: 'aid', clawId: 'c1' }),
        expectedFnName: 'emitContractVerifierStarted',
      },
      {
        name: 'passed',
        emit: (a) => emitContractVerifierPassed(a, { contractId: '', agentId: 'aid' }),
        expectedFnName: 'emitContractVerifierPassed',
      },
      {
        name: 'result_parse_failed',
        emit: (a) => emitContractVerifierResultParseFailed(a, { contractId: '', agentId: 'aid', clawId: 'c1', stage: 's', reason: 'r' }),
        expectedFnName: 'emitContractVerifierResultParseFailed',
      },
    ];

    for (const c of checks) {
      const { audit, writes } = makeFakeAudit();
      c.emit(audit);
      expect(writes, c.name).toHaveLength(1);
      expect(writes[0].event, c.name).toBe(CONTRACT_AUDIT_EVENTS.TYPED_EMIT_INVARIANT_VIOLATION);
      expect(writes[0].cols, c.name).toContain('field=contractId');
      expect(writes[0].cols, c.name).toContain(`event=${c.expectedFnName}`);
      expect(writes[0].cols, c.name).toContain('reason=empty_string');
    }
  });
});

/**
 * Phase 1134 — progress.json schema_version invariant + legacy compatibility
 */
describe('progress.json schema_version invariant — phase 1134', () => {
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-progress-schema-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('getProgress rejects schema_version > CURRENT and emits PROGRESS_SCHEMA_INVALID', async () => {
    const mockAudit = makeMockAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // overwrite with schema_version too high
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(
      progressPath,
      JSON.stringify({ schema_version: 99, contract_id: contractId, status: 'running', subtasks: {} }),
      'utf-8',
    );

    const result = await manager.getProgress(contractId);
    expect(result).toBeNull();

    const calls = mockAudit.write.mock.calls;
    const versionCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID);
    expect(versionCall).toBeDefined();
    expect(versionCall).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('path='),
        expect.stringContaining('reason=unknown_schema_version'),
        expect.stringContaining('actual=99'),
        expect.stringContaining('current=1'),
      ]),
    );
  });

  it('getProgress rejects legacy progress.json without schema_version (phase 319 strict-end)', async () => {
    const mockAudit = makeMockAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // phase 319 strict-end: legacy format (no schema_version) is now rejected by Zod
    // (mirror phase 311 ContractYaml strict pattern、ML#9 优先编译器检查)
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(
      progressPath,
      JSON.stringify({ contract_id: contractId, status: 'running', subtasks: { t1: { status: 'todo' } } }),
      'utf-8',
    );

    const progress = await manager.getProgress(contractId);
    expect(progress).toBeNull();

    // PROGRESS_SCHEMA_INVALID emit + isolation
    const badCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
    );
    expect(badCalls.length).toBeGreaterThan(0);
  });
});

/**
 * Phase 1267 D.3: acceptance→verification rename sweep lint test
 *
 * Verifies 0 occurrences of `acceptance` literal in src/core/contract/
 * except the backwards-compat migrate section in persistence.ts:66-77.
 */
describe('phase 1267 D.3 + phase 311: acceptance literal 0 hit in src/core/contract/', () => {
  it('grep acceptance in src/core/contract/ → 0 hit (backwards-compat removed by phase 311)', async () => {
    const contractDir = 'src/core/contract';
    const entries = await fs.readdir(contractDir);
    const hits: Array<{ file: string; line: number; text: string }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const filePath = path.join(contractDir, entry);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('acceptance')) continue;

        // phase 311: backwards-compat section removed; no acceptance literal allowed
        hits.push({ file: entry, line: i + 1, text: line.trim() });
      }
    }

    expect(hits).toEqual([]);
  });

  it('verification.ts parameter renamed to verificationConfig', async () => {
    const content = await fs.readFile('src/core/contract/verification.ts', 'utf-8');
    expect(content).toContain('verificationConfig: VerificationConfig');
    expect(content).not.toContain('acceptanceConfig: VerificationConfig');
  });

  it('audit-events.ts comment references verification.ts not acceptance.ts', async () => {
    const content = await fs.readFile('src/core/contract/audit-events.ts', 'utf-8');
    expect(content).toContain('verification.ts 7 处字面量收');
    expect(content).not.toContain('acceptance.ts 7 处字面量收');
  });

  it('persistence.ts comment references verification.ts:75 not acceptance.ts:75', async () => {
    const content = await fs.readFile('src/core/contract/persistence.ts', 'utf-8');
    expect(content).toContain('verification.ts:75');
    expect(content).not.toContain('acceptance.ts:75');
  });
});
