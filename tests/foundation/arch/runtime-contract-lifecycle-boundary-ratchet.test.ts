import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1360: Runtime contract lifecycle boundary', () => {
  it('owner capability contains exactly the three Runtime operations', () => {
    const source = read('src/core/contract/types.ts');
    const body = source.match(/export interface ContractRuntimeLifecycle \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(3);
    expect(body).toContain('loadActive(): Promise<Contract | null>');
    expect(body).toContain('maybeAuditStep(currentStep: number): Promise<void>');
    expect(body).toContain('close(): Promise<void>');
  });

  it('the complete owner explicitly implements the capability', () => {
    const source = read('src/core/contract/manager.ts');
    expect(source).toContain('export class ContractSystem implements ContractRuntimeLifecycle');
  });

  it('Runtime sees only the lifecycle capability', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');
    expect(types).toContain('readonly contractManager: ContractRuntimeLifecycle');
    expect(runtime).toContain('private contractManager!: ContractRuntimeLifecycle');
    expect(types).not.toMatch(/import type \{ ContractSystem \}/);
    expect(runtime).not.toMatch(/import type \{ ContractSystem \}/);
  });

  it('Runtime retains the three owner calls', () => {
    const source = read('src/core/runtime/runtime.ts');
    for (const call of ['contractManager.loadActive()', 'contractManager.maybeAuditStep(', 'contractManager.close()']) {
      expect(source).toContain(call);
    }
  });

  it('ContextInjector consumes only the active-contract reader projection', () => {
    const source = read('src/core/context_manager/injector.ts');
    expect(source).toContain("Pick<ContractRuntimeLifecycle, 'loadActive'>");
    expect(source).not.toMatch(/import type \{ ContractSystem \}/);
  });
});
