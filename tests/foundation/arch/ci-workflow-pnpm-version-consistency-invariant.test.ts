import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 626: invariant that every `pnpm/action-setup` block in
 * .github/workflows/*.yml uses the same `version: N` value.
 *
 * Rationale (ML#3 single-source toolchain): pnpm version is part of the
 * build toolchain — must be uniform across CI. Drift breaks invisibly:
 * - one CI runs pnpm v10 to parse lockfile, another v11 → same PR exhibits
 *   different behavior (one passes, one fails) for the same source
 * - debugging CI failures becomes unrepeatable (depends which workflow ran)
 *
 * Doesn't lock a specific version — only that all workflows agree.
 * Project can upgrade by editing all 3 in one commit; this invariant
 * stops the half-finished upgrade.
 *
 * Matches the YAML pattern:
 *   uses: pnpm/action-setup@vN
 *     ...
 *     with:
 *       version: N
 *
 * Pairs with phase 625 (action version pinning), phase 624 (post-merge),
 * phase 623 (CI script ref).
 */
describe('CI workflow pnpm version consistency invariant (phase 626)', () => {
  it('every pnpm/action-setup invocation uses same version', () => {
    const wfDir = path.resolve(__dirname, '../../../.github/workflows');
    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).sort();
    expect(files.length).toBeGreaterThan(0);

    // Find each pnpm/action-setup block, then capture the next `version:` value.
    // YAML matters: under `with:` block of pnpm/action-setup.
    const blockRe = /uses:\s+pnpm\/action-setup@v\d+[\s\S]*?version:\s+(\S+)/g;
    const versions: Array<{ file: string; version: string }> = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(text)) !== null) {
        versions.push({ file: f, version: m[1] });
      }
      blockRe.lastIndex = 0;
    }
    expect(versions.length).toBeGreaterThan(0);
    const uniqueVersions = new Set(versions.map(v => v.version));
    expect(uniqueVersions.size).toBe(1);
  });
});
