/**
 * vitest config invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - vitest-cachedir-gitignore-pairing-invariant.test.ts
 *  - vitest-config-setup-files-exist-invariant.test.ts
 *  - vitest-coverage-config-invariant.test.ts
 *  - vitest-exclude-base-patterns-invariant.test.ts
 *  - vitest-globals-environment-invariant.test.ts
 *  - vitest-projects-isolate-invariant.test.ts
 *  - vitest-projects-name-unique-invariant.test.ts
 *  - vitest-projects-pool-timeout-consistency-invariant.test.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('vitest-cachedir-gitignore-pairing-invariant', () => {
  /**
   * phase 645: invariant that vitest's `cacheDir` (in vitest.config.ts) is
   * paired with a matching `.gitignore` entry:
   * - vitest.config.ts contains `cacheDir: '.vitest-cache'`
   * - .gitignore contains `.vitest-cache/`
   *
   * Rationale (ML#9 explicit coupling): vitest cache write location +
   * .gitignore exclude location are an inescapable coupling. Drift breaks
   * invisibly:
   * - vitest cacheDir renamed but .gitignore not → new cache dir gets
   *   committed accidentally, git status persistently dirty
   * - .gitignore drops .vitest-cache/ entry but vitest still writes →
   *   cache enters commits
   * - vitest cacheDir reverts to default node_modules/.vite → multi-
   *   worktree share race (regression of phase 1367 fix)
   *
   * Pairs with phase 622 (.gitignore baseline patterns), phase 611
   * (vitest exclude base patterns), phase 610 (project names).
   */
  describe('vitest cacheDir ↔ .gitignore pairing invariant (phase 645)', () => {
    it('vitest.config has cacheDir=.vitest-cache + .gitignore has .vitest-cache/', () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const vitestCfg = fs.readFileSync(
        path.join(repoRoot, '.config/vitest.config.ts'),
        'utf-8',
      );
      expect(vitestCfg).toMatch(/cacheDir:\s+['"]\.vitest-cache['"]/);

      const gitignore = fs
        .readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8')
        .split('\n')
        .map(l => l.trim());
      expect(gitignore).toContain('.vitest-cache/');
    });
  });
});

describe('vitest-config-setup-files-exist-invariant', () => {
  /**
   * phase 609: invariant that vitest config's `test.setupFiles` +
   * `test.globalSetup` paths all exist on disk.
   *
   * Rationale (ML#9 explicit coupling): config-referenced files must actually
   * exist. Drift breaks invisibly:
   * - setupFiles missing → mocks / env-injection silently skipped, tests run
   *   without expected init → false-green
   * - globalSetup missing → build/dist precondition skipped, downstream
   *   smoke tests fail with confusing root cause
   *
   * vitest's behavior on missing setup paths varies by minor version — some
   * fail-loud, some silently skip. Pinning this invariant defensively.
   *
   * Pairs with phase 608 (tsconfig strict-family), phase 600 (test* SoT),
   * phase 602 (tool config SoT).
   */
  describe('vitest.config setupFiles+globalSetup path existence invariant (phase 609)', () => {
    it('every setupFiles + globalSetup path resolves to an existing file', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as {
        test?: {
          setupFiles?: string | string[];
          globalSetup?: string | string[];
        };
      };
      const testCfg = cfg.test ?? {};
      const toArr = (v: string | string[] | undefined): string[] =>
        v === undefined ? [] : Array.isArray(v) ? v : [v];

      const allPaths = [
        ...toArr(testCfg.setupFiles).map(p => ({ kind: 'setupFiles', p })),
        ...toArr(testCfg.globalSetup).map(p => ({ kind: 'globalSetup', p })),
      ];

      expect(allPaths.length).toBeGreaterThan(0);

      const missing: string[] = [];
      for (const { kind, p } of allPaths) {
        const resolved = path.resolve(repoRoot, p);
        if (!fs.existsSync(resolved)) missing.push(`${kind}: ${p} (resolved=${resolved})`);
      }
      expect(missing).toEqual([]);
    });
  });
});

describe('vitest-coverage-config-invariant', () => {
  /**
   * phase 634: invariant that vitest config's `test.coverage` is at baseline:
   * - `provider: 'v8'`               — V8 native coverage API
   * - `reporter` includes `'lcov'`   — CI / codecov integration consumes
   * - `exclude` contains `'tests/'`, `'dist/'`, `'node_modules/'` — count
   *   only src code in metrics
   *
   * Rationale (ML#3 single-source metric reporting):
   * - provider drift to istanbul → ~10x slower, V8 API features unavailable
   * - reporter drift drops lcov → CI codecov integration can't consume
   * - exclude drift drops tests/ → metrics inflated by test code coverage
   * - exclude drift drops dist/ → build output skews metric meaning
   *
   * Doesn't lock the full reporter / exclude arrays — only the baselines.
   * Project may add reporters / exclusions without changing this invariant.
   *
   * Pairs with phase 611 (vitest exclude base), phase 610 (project names),
   * phase 609 (setupFiles).
   */
  describe('vitest coverage config baseline invariant (phase 634)', () => {
    it('provider=v8 + reporter has lcov + exclude has tests/dist/node_modules', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as {
        test?: {
          coverage?: {
            provider?: string;
            reporter?: string[];
            exclude?: string[];
          };
        };
      };
      const cov = cfg.test?.coverage ?? {};
      expect(cov.provider).toBe('v8');
      expect(cov.reporter ?? []).toContain('lcov');
      const REQUIRED_EXCLUDE = ['tests/', 'dist/', 'node_modules/'];
      const missing = REQUIRED_EXCLUDE.filter(p => !(cov.exclude ?? []).includes(p));
      expect(missing).toEqual([]);
    });
  });
});

describe('vitest-exclude-base-patterns-invariant', () => {
  /**
   * phase 611: invariant that every test-level exclude array in
   * .config/vitest.config.ts (top-level + each project's test.exclude)
   * contains the 3 baseline patterns:
   *
   *   - `**\/.chestnut/**` — exclude clawspace copy tests (phase 22 hist:
   *     vitest collected `.chestnut/claws/<id>/clawspace/.../tests/**`,
   *     import failed by path depth diff, triggered hook timeout).
   *   - `**\/node_modules/**` — exclude dependency tests interference.
   *   - `**\/dist/**` — exclude build output re-testing.
   *
   * These are baseline excludes, not optional optimizations — drift breaks
   * fast-runner reliability.
   *
   * Pairs with phase 610 (project names), phase 609 (setupFiles paths),
   * phase 608 (tsconfig strict).
   */
  describe('vitest exclude base patterns invariant (phase 611)', () => {
    it('every test-level exclude contains 3 base patterns', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as {
        test?: {
          exclude?: string[];
          projects?: Array<{ test?: { exclude?: string[]; name?: string } }>;
        };
      };
      const REQUIRED = ['**/.chestnut/**', '**/node_modules/**', '**/dist/**'];
      const arrays: Array<{ label: string; arr: string[] }> = [];
      if (cfg.test?.exclude) arrays.push({ label: 'top-level', arr: cfg.test.exclude });
      for (const p of cfg.test?.projects ?? []) {
        const label = `project:${p.test?.name ?? 'unnamed'}`;
        const arr = p.test?.exclude ?? [];
        arrays.push({ label, arr });
      }

      expect(arrays.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const { label, arr } of arrays) {
        for (const pat of REQUIRED) {
          if (!arr.includes(pat)) offenders.push(`${label}: missing ${pat}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

describe('vitest-globals-environment-invariant', () => {
  /**
   * phase 655: invariant that vitest's top-level + every project has
   * `globals: true` AND `environment: 'node'`.
   *
   * Rationale (ML#3 single-source test environment): cross-project must
   * agree on test environment.
   * - globals=false somewhere → that project's tests need explicit `import
   *   { describe, it, expect } from 'vitest'`; suddenly fails loud
   * - environment=jsdom somewhere → DOM globals injected; can affect
   *   behavior of code that branches on `typeof window`
   *
   * Pairs with phase 654 (pool + timeouts consistent), phase 611 (exclude
   * base patterns), phase 610 (project names).
   */
  type Tcfg = { globals?: unknown; environment?: unknown };
  type Proj = { test?: Tcfg };

  describe('vitest globals + environment invariant (phase 655)', () => {
    it('top-level + every project: globals=true + environment=node', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as { test?: Tcfg & { projects?: Proj[] } };
      const top = cfg.test ?? {};
      const projects = top.projects ?? [];

      const surfaces: Array<{ label: string; cfg: Tcfg }> = [
        { label: 'top-level', cfg: top },
        ...projects.map((p, i) => ({
          label: `project[${i}]`,
          cfg: p.test ?? {},
        })),
      ];

      const offenders: string[] = [];
      for (const { label, cfg } of surfaces) {
        if (cfg.globals !== true) {
          offenders.push(`${label}: globals=${String(cfg.globals)}`);
        }
        if (cfg.environment !== 'node') {
          offenders.push(`${label}: environment=${String(cfg.environment)}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

describe('vitest-projects-isolate-invariant', () => {
  /**
   * phase 658: invariant that vitest projects encode their design intent
   * via poolOptions.threads.isolate:
   * - `fast` project   → isolate=false (shared module registry, high
   *                      throughput, tests must be mock-safe)
   * - `isolated` project → isolate=true (each test file isolated, prevents
   *                        cross-file mock contamination)
   *
   * Drift breaks invisibly:
   * - fast.isolate=true → 5x slow-down, no functional break
   * - isolated.isolate=false → cross-file mock contamination, tests start
   *   passing/failing depending on file ordering, ghost flakes
   *
   * Pairs with phase 655 (globals + environment), phase 654 (pool +
   * timeouts), phase 611 (exclude base patterns), phase 610 (project
   * names).
   */
  type Proj = {
    test?: {
      name?: string;
      poolOptions?: { threads?: { isolate?: unknown } };
    };
  };

  describe('vitest fast/isolated isolate invariant (phase 658)', () => {
    it('fast.isolate=false + isolated.isolate=true', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as { test?: { projects?: Proj[] } };
      const projects = cfg.test?.projects ?? [];

      const fast = projects.find(p => p.test?.name === 'fast');
      const isolated = projects.find(p => p.test?.name === 'isolated');

      expect(fast, "project named 'fast' missing").toBeDefined();
      expect(isolated, "project named 'isolated' missing").toBeDefined();

      expect((fast as Proj).test?.poolOptions?.threads?.isolate).toBe(false);
      expect((isolated as Proj).test?.poolOptions?.threads?.isolate).toBe(true);
    });
  });
});

describe('vitest-projects-name-unique-invariant', () => {
  /**
   * phase 610: invariant that every vitest project in test.projects[] has a
   * non-empty `test.name` field and all names are unique.
   *
   * Rationale: vitest projects[].test.name is the project identifier in test
   * runner UI + failure reports. Failure modes:
   * - empty / missing name → 'unnamed' project hard to disambiguate in output
   * - duplicate name → later override earlier, or behavior version-dependent;
   *   debugging which project actually ran becomes guesswork
   *
   * Pairs with phase 609 (setupFiles path existence), phase 608 (tsconfig
   * strict), phase 600/602 (config SoT).
   */
  describe('vitest projects name unique+non-empty invariant (phase 610)', () => {
    it('every project has non-empty test.name + all names unique', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as {
        test?: { projects?: Array<{ test?: { name?: unknown } }> };
      };
      const projects = cfg.test?.projects ?? [];
      expect(projects.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      const names: string[] = [];
      for (let i = 0; i < projects.length; i++) {
        const name = projects[i]?.test?.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
          offenders.push(`projects[${i}]: name=${String(name)}`);
          continue;
        }
        names.push(name);
      }
      expect(offenders).toEqual([]);
      expect(names.length).toBe(new Set(names).size);
    });
  });
});

describe('vitest-projects-pool-timeout-consistency-invariant', () => {
  /**
   * phase 654: invariant that all vitest projects share the same `pool`,
   * `testTimeout`, and `hookTimeout` values.
   *
   * Rationale (ML#3 single-source test-runner config): vitest projects are
   * a single test runner running multiple subsets. Their runtime params
   * (pool kind, timeout magnitudes) must agree, otherwise:
   * - one project times out at 5s but another at 15s → flaky tests cross
   *   project boundaries unpredictably
   * - one uses `pool: 'forks'` while another uses `'threads'` → memory
   *   isolation differs; same test can pass in one and fail in the other
   *
   * phase 1006 update: integration / infra projects need longer timeouts and
   * tighter concurrency, so the strict uniformity check applies only to the
   * unit projects (fast + isolated). All projects still use the same pool kind.
   *
   * Pairs with phase 611 (vitest exclude base patterns), phase 610
   * (projects name unique), phase 634 (coverage config baseline).
   */
  type Proj = { test?: { name?: string; pool?: unknown; testTimeout?: unknown; hookTimeout?: unknown } };

  const UNIT_PROJECT_NAMES = new Set(['fast', 'isolated']);

  describe('vitest projects pool + timeout consistency invariant (phase 654)', () => {
    it('all projects share same pool; unit projects share same testTimeout + hookTimeout', async () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const cfgPath = path.join(repoRoot, '.config/vitest.config.ts');
      const mod = (await import(cfgPath)) as { default?: unknown };
      const raw = mod.default;
      if (!raw || typeof raw !== 'object') {
        throw new Error('vitest config default export not an object');
      }
      const cfg = raw as { test?: { projects?: Proj[] } };
      const projects = cfg.test?.projects ?? [];
      expect(projects.length).toBeGreaterThan(1);

      const pools = new Set(projects.map(p => p.test?.pool));
      expect(pools.size).toBe(1);

      const unitProjects = projects.filter(p => UNIT_PROJECT_NAMES.has(p.test?.name ?? ''));
      const unitTestTimeouts = new Set(unitProjects.map(p => p.test?.testTimeout));
      const unitHookTimeouts = new Set(unitProjects.map(p => p.test?.hookTimeout));
      expect(unitTestTimeouts.size).toBe(1);
      expect(unitHookTimeouts.size).toBe(1);
    });
  });
});
