import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('phase 1387: no resolve(ctx.clawDir, "..", CLAWS_DIR) anti-pattern in src/', () => {
  it('grep src/ for buggy pattern returns 0 hit', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    let hits = '';
    try {
      hits = execSync(
        `grep -rnE "resolve\\([^)]*clawDir[^)]*['\\"]\\.\\.['\\"][^)]*CLAWS_DIR" ${srcRoot}`,
        { encoding: 'utf8' }
      );
    } catch (e: any) {
      // grep exit 1 = 0 match (expected after fix)
      if (e.status === 1) return;
      throw e;
    }
    if (hits.trim()) {
      const count = hits.split('\n').filter(Boolean).length;
      throw new Error(
        `phase 1387 invariant violation: ${count} site(s) still use buggy resolve(clawDir,'..',CLAWS_DIR) pattern:\n${hits}\nUse path.join(ctx.clawforumRoot, CLAWS_DIR) instead. See coding plan/phase1387/.`
      );
    }
  });

  it('反向自检 — regex 能命中 anti-pattern 样例', () => {
    const sample = `const x = nodePath.resolve(ctx.clawDir, '..', CLAWS_DIR);`;
    const re = /resolve\([^)]*clawDir[^)]*['"]\.\.['"][^)]*CLAWS_DIR/;
    expect(re.test(sample)).toBe(true);
  });

  it('反向自检 — fix 后样例不命中', () => {
    const sample = `const x = nodePath.join(ctx.clawforumRoot, CLAWS_DIR);`;
    const re = /resolve\([^)]*clawDir[^)]*['"]\.\.['"][^)]*CLAWS_DIR/;
    expect(re.test(sample)).toBe(false);
  });
});
