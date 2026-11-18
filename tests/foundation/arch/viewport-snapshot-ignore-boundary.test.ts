import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 2196: viewport snapshot ignore policy owned by Viewport', () => {
  it('Assembly imports and spreads VIEWPORT_SNAPSHOT_IGNORE from the owner barrel', async () => {
    const patterns = read('src/assembly/config/snapshot-patterns.ts');
    expect(patterns).toMatch(/import\s+\{[^}]*VIEWPORT_SNAPSHOT_IGNORE[^}]*\}\s+from\s+['"]\.\.\/\.\.\/viewport\/index\.js['"]/);
    expect(patterns).toContain('...VIEWPORT_SNAPSHOT_IGNORE');
    const { SNAPSHOT_IGNORE_PATTERNS } = await import('../../../src/assembly/config/snapshot-patterns.js');
    const { AUDIT_SNAPSHOT_IGNORE } = await import('../../../src/foundation/audit/index.js');
    expect(SNAPSHOT_IGNORE_PATTERNS.filter(pattern => pattern === 'viewport.tsv')).toHaveLength(1);
    expect(AUDIT_SNAPSHOT_IGNORE).not.toContain('viewport.tsv');
  });
});
