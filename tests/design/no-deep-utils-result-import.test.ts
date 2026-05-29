import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * phase 1432 F7 — foundation/utils/result.ts barrel-only invariant.
 *
 * ML#7 + ML#9：`utils/result.ts` 跨模块通道 = `utils/index.ts` barrel。
 * 跨模块 caller 只能 import barrel、不得深穿 result.ts。
 *
 * allowlist (by-design):
 *   - src/index.ts: SDK 顶层 re-export (公共 SDK 表面边界)
 *
 * cross-ref：depcruise `no-deep-into-utils-result` 同源 enforce。
 * 形态 mirror phase 1423 F2 utils/format。
 */
describe('phase 1432 F7: utils/result barrel-only invariant', () => {
  it('cross-module deep imports `from "*/utils/result.js"` baseline ratchet = 0 (excluding SDK)', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    let hits = '';
    try {
      hits = execSync(
        `grep -rnE "from ['\\\"][^'\\\"]*utils/result\\.js['\\\"]" ${srcRoot} --include='*.ts' | grep -v "/utils/" | grep -v "^${srcRoot}/index.ts:"`,
        { encoding: 'utf8' },
      );
    } catch (e: any) {
      if (e.status === 1) return;
      throw e;
    }
    if (hits.trim()) {
      const count = hits.split('\n').filter(Boolean).length;
      throw new Error(
        `phase 1432 F7 invariant violation: ${count} cross-module site(s) deep-import from utils/result.js (outside allowlist):\n${hits}\nUse \`from '.../utils/index.js'\` instead. See coding plan/phase1432/.`,
      );
    }
  });

  it('反向自检 — regex 命中 anti-pattern 样例', () => {
    const sample = `import { ok } from '../utils/result.js';`;
    const re = /from ['"][^'"]*utils\/result\.js['"]/;
    expect(re.test(sample)).toBe(true);
  });

  it('反向自检 — barrel import 样例不被命中', () => {
    const goodSample = `import { ok } from '../utils/index.js';`;
    const re = /from ['"][^'"]*utils\/result\.js['"]/;
    expect(re.test(goodSample)).toBe(false);
  });
});
