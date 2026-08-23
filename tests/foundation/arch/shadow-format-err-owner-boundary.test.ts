import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('ShadowSystem formatErr owner boundary (phase 1498)', () => {
  it('NodeUtils remains the named-export owner', () => {
    expect(read('src/foundation/node-utils/index.ts')).toMatch(/export \{ formatErr \} from '\.\/format\.js';/);
  });

  it('ShadowSystem runtime imports formatErr directly from NodeUtils', () => {
    expect(read('src/core/shadow-system/system.ts')).toMatch(
      /import \{[^}]*formatErr[^}]*\} from '\.\.\/\.\.\/foundation\/node-utils\/index\.js';/,
    );
  });

  it('ShadowSystem helpers do not forward formatErr', () => {
    expect(read('src/core/shadow-system/_helpers.ts')).not.toMatch(/export \{ formatErr \}/);
  });

  it('ShadowSystem helpers retain their business capabilities', () => {
    const helpers = read('src/core/shadow-system/_helpers.ts');
    expect(helpers).toMatch(/export function stripIncompleteToolUse\(/);
    expect(helpers).toMatch(/export function synthesizeFormB\(/);
  });
});
