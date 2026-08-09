import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REMOVED_EXPORTS = [
  'ContractSystemDeps',
] as const;

function walkTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(target);
    return entry.name.endsWith('.ts') ? [target] : [];
  });
}

describe('phase 1349: ContractSystem public surface ratchet', () => {
  const contractDir = path.join(process.cwd(), 'src/core/contract');
  const barrelPath = path.join(contractDir, 'index.ts');

  it('owner-internal types remain defined but are absent from the public barrel', () => {
    const barrel = fs.readFileSync(barrelPath, 'utf8');
    const ownerSources = walkTs(contractDir)
      .filter((file) => file !== barrelPath)
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    for (const symbol of REMOVED_EXPORTS) {
      expect(barrel).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      expect(ownerSources).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });

  it('production modules do not import the removed types from ContractSystem barrel', () => {
    const externalSources = walkTs(path.join(process.cwd(), 'src'))
      .filter((file) => !file.startsWith(`${contractDir}${path.sep}`))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    for (const symbol of REMOVED_EXPORTS) {
      const importFromContractBarrel = new RegExp(
        `import[\\s\\S]{0,500}\\b${symbol}\\b[\\s\\S]{0,500}from ['\"][^'\"]*core/contract/index\\.js['\"]`,
      );
      expect(externalSources).not.toMatch(importFromContractBarrel);
    }
  });
});
