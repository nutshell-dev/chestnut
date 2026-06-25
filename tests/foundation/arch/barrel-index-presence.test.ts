import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 507: invariant that every foundation submodule with a non-trivial
 * directory has an index.ts barrel.
 *
 * This protects against accidentally creating a deep-only module that
 * bypasses the M#7 barrel-only convention.
 *
 * phase 567 扩: 加 core/<module>/ 同型扫描。core 当前 19 submodule 全有 barrel、
 * ratchet 防 future drift 新建 core 子模块 0 barrel。
 */
describe('foundation + core barrel index.ts presence (phase 507 / phase 567 expanded)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
  const foundationDir = path.join(srcRoot, 'foundation');
  const coreDir = path.join(srcRoot, 'core');

  // phase 740: core/permissions barrel removed as dead code (0 imports).
  // The directory still contains implementation files, so it is intentionally
  // exempt from the barrel-presence ratchet until it is re-barreled or folded
  // into another module.
  const CORE_BARREL_EXCEPTIONS = new Set(['permissions']);

  function scanForMissingBarrels(rootDir: string, exceptions?: Set<string>): string[] {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const missing: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (exceptions?.has(entry.name)) continue;
      const indexPath = path.join(rootDir, entry.name, 'index.ts');
      if (!fs.existsSync(indexPath)) {
        missing.push(entry.name);
      }
    }
    return missing;
  }

  it('each foundation/<module>/ directory has an index.ts barrel', () => {
    expect(scanForMissingBarrels(foundationDir)).toEqual([]);
  });

  it('each core/<module>/ directory has an index.ts barrel (phase 567)', () => {
    expect(scanForMissingBarrels(coreDir, CORE_BARREL_EXCEPTIONS)).toEqual([]);
  });
});
