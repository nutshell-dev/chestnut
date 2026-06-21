import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 657: invariant that the main eslint config object registers both
 * `@typescript-eslint` and `chestnut-custom` in its `plugins:` block.
 *
 * Rationale (ML#3 single-source rule hosting):
 * - missing `@typescript-eslint` → type-aware rules can't load (even if
 *   none enabled currently, the parser+plugin pair is required for
 *   tsParser to work end-to-end)
 * - missing `chestnut-custom` → all 32 chestnut-custom rules silently
 *   stop firing
 *
 * Doesn't lock plugins to exactly these 2 — allows future addition of
 * other plugins.
 *
 * Pairs with phase 591 (3-way plugin/rules pairing), phase 616
 * (languageOptions baseline), phase 596 (meta.type=problem).
 */
type EslintConfig = { plugins?: Record<string, unknown> };

describe('eslint.config plugins set invariant (phase 657)', () => {
  it('main config registers @typescript-eslint + chestnut-custom plugins', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/eslint.config.js');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    const cfgs: EslintConfig[] = Array.isArray(raw) ? (raw as EslintConfig[]) : [];
    expect(cfgs.length).toBeGreaterThan(0);

    const main = cfgs.find(c => c.plugins && 'chestnut-custom' in c.plugins);
    expect(main, 'no config object with chestnut-custom plugin').toBeDefined();

    const plugins = (main as EslintConfig).plugins ?? {};
    const REQUIRED = ['@typescript-eslint', 'chestnut-custom'];
    const missing = REQUIRED.filter(p => !(p in plugins));
    expect(missing).toEqual([]);
  });
});
