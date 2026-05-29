import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * phase 1432 F6 — foundation/dialog-store/dirs.ts barrel-only invariant.
 *
 * ML#7 + ML#9：`dialog-store/dirs.ts` 的 path const 跨模块通道 = barrel。
 * 跨模块 caller (cli/) 只能 import dialog-store/index.ts、不得深穿 dirs.ts。
 *
 * allowlist (by-design):
 *   - src/assembly/assemble.ts: 装配根 bootstrap by-design
 *
 * cross-ref：depcruise `no-deep-into-dialog-store-dirs` 同源 enforce。
 * 形态 mirror phase 1423 F4 messaging/dirs。
 */
describe('phase 1432 F6: dialog-store/dirs barrel-only invariant', () => {
  it('cross-module deep imports `from "*/dialog-store/dirs.js"` baseline ratchet = 0 (excluding assembly bootstrap)', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    let hits = '';
    try {
      hits = execSync(
        `grep -rnE "from ['\\\"][^'\\\"]*dialog-store/dirs\\.js['\\\"]" ${srcRoot} --include='*.ts' | grep -v "/dialog-store/" | grep -v "^${srcRoot}/assembly/assemble.ts:"`,
        { encoding: 'utf8' },
      );
    } catch (e: any) {
      if (e.status === 1) return;
      throw e;
    }
    if (hits.trim()) {
      const count = hits.split('\n').filter(Boolean).length;
      throw new Error(
        `phase 1432 F6 invariant violation: ${count} cross-module site(s) deep-import from dialog-store/dirs.js (outside allowlist):\n${hits}\nUse \`from '.../dialog-store/index.js'\` instead. See coding plan/phase1432/.`,
      );
    }
  });

  it('反向自检 — regex 命中 anti-pattern 样例', () => {
    const sample = `import { DIALOG_DIR } from '../../foundation/dialog-store/dirs.js';`;
    const re = /from ['"][^'"]*dialog-store\/dirs\.js['"]/;
    expect(re.test(sample)).toBe(true);
  });

  it('反向自检 — barrel import 样例不被命中', () => {
    const goodSample = `import { DIALOG_DIR } from '../../foundation/dialog-store/index.js';`;
    const re = /from ['"][^'"]*dialog-store\/dirs\.js['"]/;
    expect(re.test(goodSample)).toBe(false);
  });
});
