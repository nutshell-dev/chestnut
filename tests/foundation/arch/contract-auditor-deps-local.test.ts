import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditorSource = readFileSync(
  new URL('../../../src/core/contract/contract-auditor.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ContractAuditorDeps deep surface', () => {
  it('keeps the auditor deps type local behind the ContractAuditor class', () => {
    expect(auditorSource).not.toMatch(/export\s+interface\s+ContractAuditorDeps\b/);
    expect(auditorSource).toMatch(
      /(?:^|\n)interface\s+ContractAuditorDeps\s*\{\s*\n\s*audit:\s*AuditLog;\s*\n\s*fs:\s*FileSystem;\s*\n\s*inbox:\s*InboxWriter;\s*\n\s*llm:\s*LLMOrchestrator;/,
    );
    expect(auditorSource).toMatch(/export\s+class\s+ContractAuditor\b/);
    expect(auditorSource).toMatch(/constructor\(deps:\s*ContractAuditorDeps\)/);
    expect(barrelSource).toMatch(
      /export\s*\{\s*ContractAuditor\s*\}\s*from\s*'\.\/contract-auditor\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bContractAuditorDeps\b/);
  });
});
