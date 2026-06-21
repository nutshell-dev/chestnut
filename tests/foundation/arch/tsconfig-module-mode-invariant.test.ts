import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 619: invariant that tsconfig.json compilerOptions module-mode
 * baseline is:
 * - target === 'ES2022'
 * - module === 'NodeNext'
 * - moduleResolution === 'NodeNext'
 * - lib === ['ES2022']
 *
 * Rationale (ML#3 single-source module mode): tsc module mode + package.json
 * type=module + tsup target jointly decide .js parse behavior.
 * - target drift down (ES2018) → ES2022 syntax (?? =, structuredClone) fails
 *   to type-check or runtime-error
 * - module/moduleResolution drift off NodeNext → import path resolution
 *   changes (e.g. missing .js suffix in ESM)
 * - lib drift → missing ES2022 globals (Array.prototype.at, structuredClone)
 *
 * Pairs with phase 608 (strict-family), phase 618 (scope baseline), phase
 * 612 (package.json type=module), phase 614 (tsup target uniformity).
 */
describe('tsconfig.json module mode baseline invariant (phase 619)', () => {
  it('target/module/moduleResolution/lib match baseline', () => {
    const cfgPath = path.resolve(__dirname, '../../../tsconfig.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      compilerOptions?: {
        target?: unknown;
        module?: unknown;
        moduleResolution?: unknown;
        lib?: unknown;
      };
    };
    const co = cfg.compilerOptions ?? {};
    expect(co.target).toBe('ES2022');
    expect(co.module).toBe('NodeNext');
    expect(co.moduleResolution).toBe('NodeNext');
    expect(co.lib).toEqual(['ES2022']);
  });
});
