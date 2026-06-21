import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 627: invariant that every `node-version:` in CI workflows has a
 * major version ≥ the major version in package.json `engines.node`.
 *
 * Rationale (ML#9 explicit coupling): engines.node + CI node-version must
 * satisfy a containment relation — CI versions ⊆ engines-allowed range.
 * Drift breaks invisibly:
 * - engines.node bumped to '>=24' but CI keeps testing 22.x → CI passes
 *   on unsupported version; users on 24+ may hit untested failures
 * - CI adds 18.x to matrix but engines.node still '>=20.18.0' → CI runs
 *   unsupported version; passes mean nothing for engines-compliant users
 *
 * The invariant doesn't lock a specific major (project may upgrade either
 * side independently as long as the containment holds).
 *
 * Pairs with phase 626 (pnpm version consistency), phase 625 (action
 * pinning), phase 621 (package identity).
 */
describe('CI node-version vs engines.node invariant (phase 627)', () => {
  it('every CI node-version major >= engines.node minMajor', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      engines?: { node?: string };
    };
    const enginesNode = pkg.engines?.node;
    expect(typeof enginesNode).toBe('string');
    const minMatch = (enginesNode as string).match(/^>=(\d+)/);
    expect(minMatch).not.toBeNull();
    const minMajor = parseInt(minMatch![1], 10);

    const wfDir = path.join(repoRoot, '.github/workflows');
    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).sort();
    expect(files.length).toBeGreaterThan(0);

    // matches `node-version: <value>` lines (with optional quotes/array brackets)
    const lineRe = /node-version:\s+(\S+(?:\s*,\s*\S+)*)/g;
    const versionRe = /(\d+)\.[\d.xX]+/g;
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      let lm: RegExpExecArray | null;
      while ((lm = lineRe.exec(text)) !== null) {
        // Skip `${{ matrix.node-version }}` substitutions — already resolved
        // by the matrix line.
        const val = lm[1];
        if (val.includes('${{')) continue;
        let vm: RegExpExecArray | null;
        while ((vm = versionRe.exec(val)) !== null) {
          const major = parseInt(vm[1], 10);
          if (major < minMajor) {
            offenders.push(`${f}: node-version ${vm[0]} major=${major} < minMajor=${minMajor}`);
          }
        }
        versionRe.lastIndex = 0;
      }
      lineRe.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
