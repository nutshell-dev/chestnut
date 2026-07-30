import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 1243 Step F ratchet: business owner modules must not re-introduce the
 * standard system passthrough formatter. They should declare `kind: 'standard'`
 * with `presentation: 'system'` instead.
 *
 * Excludes:
 * - Messaging's own `renderStandardInboxMessage` (the single canonical renderer)
 * - Heartbeat's real custom formatter (different body / I/O + audit)
 */
describe('inbox standard rendering reflux ratchet (phase 1243)', () => {
  const projectRoot = path.join(__dirname, '..', '..', '..');
  const ownerDirs = [
    path.join(projectRoot, 'src', 'core'),
    path.join(projectRoot, 'src', 'watchdog'),
    path.join(projectRoot, 'src', 'daemon'),
  ];
  const fixturesDir = path.join(__dirname, 'fixtures');

  const SHAPED_WRAPPER_RE =
    /async\s*\(\s*\{\s*body\s*,\s*timestampSec\s*\}\s*\)\s*=>\s*`\[system message\$\{timestampSec\}\] \$\{body\}`/;

  function scanForShapedWrapper(dir: string): string[] {
    const matches: string[] = [];
    function walk(current: string) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf-8');
          if (SHAPED_WRAPPER_RE.test(content)) {
            matches.push(path.relative(projectRoot, full));
          }
        }
      }
    }
    walk(dir);
    return matches;
  }

  it('production owner surface has no shaped system passthrough wrappers', () => {
    const matches: string[] = [];
    for (const dir of ownerDirs) {
      matches.push(...scanForShapedWrapper(dir));
    }
    expect(matches).toEqual([]);
  });

  it('scanner detects shaped wrapper fixture', () => {
    expect(scanForShapedWrapper(fixturesDir)).toContain(
      'tests/foundation/arch/fixtures/inbox-standard-rendering-violation.ts',
    );
  });
});
