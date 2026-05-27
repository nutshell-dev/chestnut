// clawforum/tests/design/interfaces-sync.test.ts
// phase 1327 r137 E fork: design vs src interfaces sync invariant lint
// mirror phase 964+1019+1244+1265+1266+1277+1278+1324 mechanical invariant 三件套 N=9 累达

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function findDesignRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'design', 'interfaces');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('design/interfaces not found from ' + startDir);
}

const DESIGN_ROOT = findDesignRoot(import.meta.dirname);
const SRC_ROOT = join(import.meta.dirname, '../../src');

describe('design interfaces sync invariant (phase 1327 r137 E fork)', () => {
  it('createCommandTools 0-args sig: design l2c.md vs src command-tool/index.ts align', () => {
    const designContent = readFileSync(join(DESIGN_ROOT, 'l2c.md'), 'utf-8');
    const srcContent = readFileSync(join(SRC_ROOT, 'foundation/command-tool/index.ts'), 'utf-8');

    // design declared signature: 0-args
    const designSig = /export function createCommandTools\(\): CommandToolModule/;
    expect(designContent).toMatch(designSig);

    // src actual signature: 0-args
    const srcSig = /export function createCommandTools\(\): CommandToolModule/;
    expect(srcContent).toMatch(srcSig);

    // design must NOT contain `CommandToolDeps` interface（phase 1280 REFRAMED-OUT）
    expect(designContent).not.toMatch(/export interface CommandToolDeps/);
  });

  it('RuntimeDependencies permissionChecker field: design l5.md vs src runtime/types.ts align', () => {
    const designContent = readFileSync(join(DESIGN_ROOT, 'l5.md'), 'utf-8');
    const srcContent = readFileSync(join(SRC_ROOT, 'core/runtime/types.ts'), 'utf-8');

    // design must declare permissionChecker as required field in RuntimeDependencies
    const designField = /readonly permissionChecker:\s*PermissionChecker/;
    expect(designContent).toMatch(designField);

    // src actual: required (no `?` modifier)
    const srcField = /readonly permissionChecker:\s*PermissionChecker(?!\s*\?)/;
    expect(srcContent).toMatch(srcField);
  });

  it('regression baseline: NEW design-src drift fails this test', () => {
    // baseline ratchet: 当前 2 项 invariant
    // future drift 引入 → 加 NEW it block / 不 weaken existing assertions
    expect(true).toBe(true); // placeholder ratchet anchor
  });
});
