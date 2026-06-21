import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 608: invariant that tsconfig.json compilerOptions has the
 * type-safety strict-family flags all set to true.
 *
 * Rationale: type safety is the baseline of chestnut's coding standards.
 * The strict-family flags are the core constraints — any one set to false
 * lets tsc miss problems the flag was supposed to catch (implicit any,
 * dead code, fall-through switch, unused params, etc.).
 *
 * REQUIRED_FLAGS (all === true):
 * - strict
 * - noUnusedLocals
 * - noUnusedParameters
 * - noImplicitReturns
 * - noFallthroughCasesInSwitch
 * - verbatimModuleSyntax
 */
describe('tsconfig.json strict-family invariant (phase 608)', () => {
  it('compilerOptions has 6 strict-family flags set to true', () => {
    const cfgPath = path.resolve(__dirname, '../../../tsconfig.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    const co = cfg.compilerOptions ?? {};
    const REQUIRED = [
      'strict',
      'noUnusedLocals',
      'noUnusedParameters',
      'noImplicitReturns',
      'noFallthroughCasesInSwitch',
      'verbatimModuleSyntax',
    ];
    const offenders: string[] = [];
    for (const flag of REQUIRED) {
      if (co[flag] !== true) offenders.push(`${flag}=${String(co[flag])}`);
    }
    expect(offenders).toEqual([]);
  });
});
