import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('SpawnSystem formatErr owner boundary (phase 1497)', () => {
  it('NodeUtils remains the named-export owner', () => {
    expect(read('src/foundation/node-utils/index.ts')).toMatch(/export \{ formatErr \} from '\.\/format\.js';/);
  });

  it('sync runtime imports formatErr directly from NodeUtils', () => {
    expect(read('src/core/spawn-system/system.ts')).toMatch(
      /import \{[^}]*formatErr[^}]*\} from '\.\.\/\.\.\/foundation\/node-utils\/index\.js';/,
    );
  });

  it('spawn tool imports formatErr directly from NodeUtils', () => {
    expect(read('src/core/spawn-system/tools/spawn.ts')).toMatch(
      /import \{[^}]*formatErr[^}]*\} from '\.\.\/\.\.\/\.\.\/foundation\/node-utils\/index\.js';/,
    );
  });

  it('does not keep a SpawnSystem forwarding facade', () => {
    expect(fs.existsSync(path.join(root, 'src/core/spawn-system/_helpers.ts'))).toBe(false);
  });
});
