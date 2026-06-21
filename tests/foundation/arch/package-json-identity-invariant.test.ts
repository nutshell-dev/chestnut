import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 621: invariant that package.json publish identity fields are at
 * baseline:
 * - name === 'chestnut'
 * - license === 'MIT'
 * - engines.node startsWith '>=20'
 * - keywords is non-empty array
 *
 * Rationale (ML#3 single-source identity):
 * - name drift → npm publish ships under a different name; users of old
 *   name break + ecosystem fragmentation
 * - license drift → compliance / legal exposure
 * - engines.node drift below 20 → users on insufficient Node version see
 *   install succeed but runtime fail with cryptic error (npm warns but
 *   doesn't block)
 * - keywords empty → npm search invisible
 *
 * Excludes `version` (must change every release) and `description` (may
 * legitimately edit over time).
 *
 * Pairs with phase 612 (entry points), phase 613 (tsup pairing), phase
 * 620 (tsconfig build behavior).
 */
describe('package.json identity invariant (phase 621)', () => {
  it('name + license + engines.node + keywords match baseline', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      name?: unknown;
      license?: unknown;
      engines?: { node?: unknown };
      keywords?: unknown;
    };

    expect(pkg.name).toBe('chestnut');
    expect(pkg.license).toBe('MIT');
    const nodeRange = pkg.engines?.node;
    expect(typeof nodeRange).toBe('string');
    expect((nodeRange as string).startsWith('>=20')).toBe(true);
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect((pkg.keywords as unknown[]).length).toBeGreaterThan(0);
  });
});
