import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 620: invariant that tsconfig.json compilerOptions build-behavior
 * flags are at baseline:
 * - esModuleInterop === true        — ESM/CJS interop
 * - skipLibCheck === true           — skip .d.ts in node_modules
 * - forceConsistentCasingInFileNames === true — defend macOS case-insensitive
 * - resolveJsonModule === true      — allow JSON import
 * - declaration === true            — emit .d.ts
 * - declarationMap === true         — emit .d.ts.map (IDE jump-to-source)
 * - sourceMap === true              — emit .js.map (debug stack)
 *
 * Plus: types === ['node'] — limit ambient global types to @types/node only,
 * preventing ambient pollution from other @types/* packages.
 *
 * Pairs with phase 608 (strict-family), phase 618 (scope), phase 619
 * (module mode). Closes the remaining compilerOptions coverage gap.
 */
describe('tsconfig.json build behavior baseline invariant (phase 620)', () => {
  it('7 build behavior flags + types match baseline', () => {
    const cfgPath = path.resolve(__dirname, '../../../tsconfig.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    const co = cfg.compilerOptions ?? {};
    const REQUIRED_TRUE = [
      'esModuleInterop',
      'skipLibCheck',
      'forceConsistentCasingInFileNames',
      'resolveJsonModule',
      'declaration',
      'declarationMap',
      'sourceMap',
    ];
    const offenders: string[] = [];
    for (const flag of REQUIRED_TRUE) {
      if (co[flag] !== true) offenders.push(`${flag}=${String(co[flag])}`);
    }
    expect(offenders).toEqual([]);
    expect(co.types).toEqual(['node']);
  });
});
