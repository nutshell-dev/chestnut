import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 625: invariant that every GitHub Actions `uses:` reference in
 * .github/workflows/*.yml is version-pinned to `@vN[.M[.P]]` or a 40-char
 * commit SHA. Bans `@main`, `@master`, `@latest`, and unversioned refs.
 *
 * Rationale (ML#3 single-source + security baseline):
 * - `@main` / `@master` → action author's push to main immediately changes
 *   what CI runs; can introduce breaking changes or — worse — silent
 *   security regression if the action publisher is compromised.
 * - `@latest` → similar non-reproducibility.
 * - unversioned (just `owner/repo`) → GitHub default behavior is
 *   action-specific, generally unpredictable.
 *
 * Pins to `@vN` (or SHA) provide reproducibility + bounded blast radius.
 * Lock at this level (allow any version), not a specific version (allow
 * the project to upgrade without changing this invariant).
 *
 * Pairs with phase 624 (post-merge hook), phase 623 (CI script ref),
 * phase 622 (.gitignore baseline).
 */
describe('CI workflow action version pinning invariant (phase 625)', () => {
  it('every uses: ref pins @vN or @<40-hex-sha>', () => {
    const wfDir = path.resolve(__dirname, '../../../.github/workflows');
    const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).sort();
    expect(files.length).toBeGreaterThan(0);

    const usesRe = /uses:\s+([\w.-]+\/[\w.-]+)@(\S+)/g;
    const semverOrV = /^v?\d+(\.\d+){0,2}$/;
    const sha40 = /^[a-f0-9]{40}$/;
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(wfDir, f), 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = usesRe.exec(text)) !== null) {
        const repo = m[1];
        const ref = m[2];
        if (!semverOrV.test(ref) && !sha40.test(ref)) {
          offenders.push(`${f}: ${repo}@${ref}`);
        }
      }
      usesRe.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
