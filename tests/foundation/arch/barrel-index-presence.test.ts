import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 507: invariant that every foundation submodule with a non-trivial
 * directory has an index.ts barrel.
 *
 * This protects against accidentally creating a deep-only module that
 * bypasses the M#7 barrel-only convention.
 */
describe('foundation barrel index.ts presence (phase 507)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
  const foundationDir = path.join(srcRoot, 'foundation');

  it('each foundation/<module>/ directory has an index.ts barrel', () => {
    const entries = fs.readdirSync(foundationDir, { withFileTypes: true });
    const missingBarrels: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexPath = path.join(foundationDir, entry.name, 'index.ts');
      if (!fs.existsSync(indexPath)) {
        missingBarrels.push(entry.name);
      }
    }
    expect(missingBarrels).toEqual([]);
  });
});
