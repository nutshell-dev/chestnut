import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 623: invariant that every `pnpm run <script>` invocation in
 * .github/workflows/*.yml references a script defined in package.json.
 *
 * Rationale (ML#9 explicit coupling): workflow yml literals + package.json
 * scripts are an inescapable coupling. Drift breaks invisibly:
 * - rename script (lint:lint → lint:eslint) but forget workflow → CI
 *   fails on push with "Missing script: lint:lint"; sometimes only caught
 *   on push to main (not PR if PR didn't trigger that workflow).
 * - delete script but workflow still calls → same break.
 *
 * One-way: workflow → package.json (workflow ref must exist). Reverse
 * direction (package.json script → workflow) is intentionally NOT
 * enforced; not every dev script needs CI.
 *
 * Pairs with phase 622 (.gitignore baseline), phase 621 (package
 * identity), phase 600/602 (script config SoT).
 */
describe('CI workflow pnpm script ref invariant (phase 623)', () => {
  it('every pnpm run <script> in .github/workflows references a defined script', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const scriptNames = new Set(Object.keys(pkg.scripts));

    const wfDir = path.join(repoRoot, '.github/workflows');
    const wfFiles = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).sort();
    expect(wfFiles.length).toBeGreaterThan(0);

    const pnpmRunRe = /pnpm run ([a-zA-Z:][a-zA-Z0-9:_-]*)/g;
    const offenders: string[] = [];
    for (const f of wfFiles) {
      const text = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = pnpmRunRe.exec(text)) !== null) {
        const ref = m[1];
        if (!scriptNames.has(ref)) {
          offenders.push(`${f}: pnpm run ${ref} (not in package.json scripts)`);
        }
      }
      pnpmRunRe.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
