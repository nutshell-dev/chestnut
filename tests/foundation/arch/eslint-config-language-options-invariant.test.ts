import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 616: invariant that .config/eslint.config.js main config object
 * has the baseline languageOptions:
 * - files === ['src/**\/*.ts']
 * - languageOptions.parserOptions.ecmaVersion === 'latest'
 * - languageOptions.parserOptions.sourceType === 'module'
 * - languageOptions.parserOptions.project === './tsconfig.json'
 *
 * Rationale: ESLint flat config languageOptions is the parser/AST baseline.
 * - files drift → miss / over-scan .ts files
 * - ecmaVersion drift → parser misses new syntax → false errors
 * - sourceType drift → module/script flip, import/export parse breaks
 * - project drift → type-aware typescript-eslint rules silently fallback
 *   to no-type mode → false-green warnings
 *
 * The main config is identified by presence of plugins['chestnut-custom']
 * (the chestnut-custom rule registration block).
 *
 * Pairs with phase 615 (depcruise options), phase 608 (tsconfig strict),
 * phase 596 (rule meta.type), phase 591 (3-way pairing).
 */
type EslintConfig = {
  files?: unknown;
  languageOptions?: {
    parserOptions?: {
      ecmaVersion?: unknown;
      sourceType?: unknown;
      project?: unknown;
    };
  };
  plugins?: Record<string, unknown>;
};

describe('eslint.config languageOptions baseline invariant (phase 616)', () => {
  it('main config has files + parserOptions baseline', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/eslint.config.js');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    const cfgs: EslintConfig[] = Array.isArray(raw) ? (raw as EslintConfig[]) : [];
    expect(cfgs.length).toBeGreaterThan(0);

    const main = cfgs.find(c => c.plugins && 'chestnut-custom' in c.plugins);
    expect(main).toBeDefined();
    const m = main as EslintConfig;
    expect(m.files).toEqual(['src/**/*.ts']);
    const po = m.languageOptions?.parserOptions ?? {};
    expect(po.ecmaVersion).toBe('latest');
    expect(po.sourceType).toBe('module');
    expect(po.project).toBe('./tsconfig.json');
  });
});
