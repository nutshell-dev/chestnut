import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 640: invariant that:
 * - pnpm-lock.yaml declares `lockfileVersion: '9.0'` near the top
 *   (current pnpm 10 produces this; drift means lockfile format changed
 *   under us, possibly breaking CI install)
 * - README.md exists (project entry-point documentation)
 * - CONTRIBUTING.md exists (contribution process documentation)
 *
 * Rationale: pnpm-lock version is the SoT for dependency-resolution
 * format. Mismatch with installed pnpm major can cause CI install to
 * fail or silently re-resolve unintended versions. README/CONTRIBUTING
 * are project onboarding SoT — accidental deletion → users hit
 * documentation cliff.
 *
 * Extends phase 639 (LICENSE / pnpm-lock existence / .gitattributes) with
 * lockfile version content + onboarding doc presence.
 */
describe('pnpm-lock.yaml version + README/CONTRIBUTING invariant (phase 640)', () => {
  it('lockfile declares 9.0 + entry-point docs exist', () => {
    const repoRoot = path.resolve(__dirname, '../../..');

    const lockPath = path.join(repoRoot, 'pnpm-lock.yaml');
    expect(fs.existsSync(lockPath)).toBe(true);
    const lockHead = fs
      .readFileSync(lockPath, 'utf-8')
      .split('\n')
      .slice(0, 10)
      .join('\n');
    expect(lockHead).toContain("lockfileVersion: '9.0'");

    expect(fs.existsSync(path.join(repoRoot, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'CONTRIBUTING.md'))).toBe(true);
  });
});
