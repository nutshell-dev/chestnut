import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Contract audit formatErr owner boundary (phase 1499)', () => {
  it('NodeUtils remains the named-export owner', () => {
    expect(read('src/foundation/node-utils/index.ts')).toMatch(/export \{ formatErr \} from '\.\/format\.js';/);
  });

  it('Contract audit emit does not import formatErr', () => {
    expect(read('src/core/contract/audit-emit.ts')).not.toMatch(/import \{[^}]*formatErr[^}]*\}/);
  });

  it('Contract audit emit does not export formatErr', () => {
    expect(read('src/core/contract/audit-emit.ts')).not.toMatch(/export \{[^}]*formatErr[^}]*\}/);
  });
});
