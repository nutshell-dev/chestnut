import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * phase 1413 — Assembly CONFIG_DEFAULTS barrel-only invariant.
 *
 * ML#7 + ML#9：CONFIG_DEFAULTS 跨层暴露通道唯一 = `src/assembly/index.ts` barrel。
 * 跨模块 caller（cli/, daemon-entry.ts, watchdog/）只能 import barrel、
 * 不得深穿 `assembly/config-defaults.ts`。
 *
 * 历史：phase 942 ε-inject CONFIG_DEFAULTS 到 `assembly/config-defaults.ts`、
 * 18 site 越 barrel 深穿（cli 15 + cli/index + daemon-entry + watchdog-context）。
 * phase 1413 加 barrel re-export + 18 site 改 import 路径 + 本 invariant test
 * 防 future drift。
 *
 * scope: 本测仅治 CONFIG_DEFAULTS。sister deep imports（SNAPSHOT_IGNORE_PATTERNS
 * from snapshot-patterns.ts / ASSEMBLY_AUDIT_EVENTS from audit-events.ts）属同型
 * sister drift、留 follow-up phase 治（需配套修 tests/cli/stop-orphan-* total mock）。
 *
 * cross-ref：depcruise `no-deep-into-assembly-config-defaults` forbidden rule 同源 enforce。
 */
describe('phase 1413: CONFIG_DEFAULTS barrel-only invariant', () => {
  it('cross-module deep imports `from "*/assembly/config-defaults.js"` baseline ratchet = 0', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    let hits = '';
    try {
      hits = execSync(
        `grep -rnE "from ['\\\"][^'\\\"]*assembly/config-defaults\\.js['\\\"]" ${srcRoot} --include='*.ts' | grep -v "/assembly/"`,
        { encoding: 'utf8' },
      );
    } catch (e: any) {
      if (e.status === 1) return; // 0 match expected
      throw e;
    }
    if (hits.trim()) {
      const count = hits.split('\n').filter(Boolean).length;
      throw new Error(
        `phase 1413 invariant violation: ${count} cross-module site(s) deep-import from src/assembly/config-defaults.js:\n${hits}\nUse \`from '.../assembly/index.js'\` instead. See coding plan/phase1413/.`,
      );
    }
  });

  it('反向自检 — regex 命中 anti-pattern 样例', () => {
    const sample = `import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';`;
    const re = /from ['"][^'"]*assembly\/config-defaults\.js['"]/;
    expect(re.test(sample)).toBe(true);
  });

  it('反向自检 — barrel import 样例不被命中', () => {
    const goodSample = `import { CONFIG_DEFAULTS } from '../../assembly/index.js';`;
    const re = /from ['"][^'"]*assembly\/config-defaults\.js['"]/;
    expect(re.test(goodSample)).toBe(false);
  });
});
