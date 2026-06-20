import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 504: invariant test that resource owner modules physically exist.
 *
 * Lint rules and ratchet tests reference these paths. If anyone renames
 * or removes them without updating dependent rules, this catches it.
 */
describe('resource owner modules physical presence (phase 504)', () => {
  const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

  const owners = [
    { name: 'foundation/fs (L1 owner)', rel: 'foundation/fs/node-fs.ts' },
    { name: 'foundation/uuid (entropy owner)', rel: 'foundation/uuid.ts' },
    { name: 'foundation/hash (hash owner)', rel: 'foundation/hash.ts' },
    { name: 'foundation/process-exec (child_process owner)', rel: 'foundation/process-exec/exec.ts' },
    { name: 'foundation/transport (net owner)', rel: 'foundation/transport/unix-socket.ts' },
  ];

  it.each(owners)('$name file exists at expected path: $rel', ({ rel }) => {
    const full = path.join(srcRoot, rel);
    expect(fs.existsSync(full)).toBe(true);
  });
});
