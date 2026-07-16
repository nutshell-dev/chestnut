import { describe, expect, it } from 'vitest';

// The production tool is plain ESM so Node can execute it without a TS loader.
// @ts-expect-error No declaration file is intentionally emitted for this CLI module.
import { aggregateRawRuns, compareSummaries, renderReport } from '../../scripts/test-cost-baseline.mjs';

function raw(preRun: number, dependencySelf: number) {
  return {
    schemaVersion: 1,
    modules: [{
      projectName: 'fast', moduleId: 'tests/a.test.ts',
      environmentSetupMs: 1, prepareMs: 2, setupMs: 3,
      collectMs: preRun - 6, preRunMs: preRun, testAndHooksMs: 4,
      imports: [{ moduleId: 'src/shared.ts', selfMs: dependencySelf, totalMs: dependencySelf + 2 }],
    }],
  };
}

function manifest(workers = 4) {
  return {
    schemaVersion: 1,
    environment: {
      nodeVersion: 'v20', vitestVersion: 'vitest/3.2.4', os: 'darwin', arch: 'arm64',
      cpuModel: 'fixture', vitestConfigHash: 'abc',
    },
    options: { workers, projects: ['fast'], warmup: 1, runs: 3, filters: [] },
  };
}

describe('test-cost baseline aggregation', () => {
  it('uses medians and ranks dependency exclusive cumulative cost', () => {
    const summary = aggregateRawRuns([raw(10, 2), raw(30, 6), raw(20, 4)], manifest());
    expect(summary.files[0]).toMatchObject({ preRunMedianMs: 20, collectMedianMs: 14 });
    expect(summary.dependencies[0]).toMatchObject({
      moduleId: 'src/shared.ts', fanInFiles: 1, selfMedianMs: 4, selfSumMedianMs: 4,
    });
    expect(renderReport(summary, 1)).toContain('src/shared.ts');
  });

  it('rejects measured runs with different module sets', () => {
    const changed = raw(10, 2);
    changed.modules[0].moduleId = 'tests/b.test.ts';
    expect(() => aggregateRawRuns([raw(10, 2), changed], manifest())).toThrow(/module set differs/);
  });

  it('refuses comparisons when environment-affecting fields differ', () => {
    const left = aggregateRawRuns([raw(10, 2)], manifest(2));
    const right = aggregateRawRuns([raw(9, 2)], manifest(4));
    expect(() => compareSummaries(left, right)).toThrow(/workers/);
  });

  it('reports per-file deltas for comparable baselines', () => {
    const left = aggregateRawRuns([raw(10, 2)], manifest());
    const right = aggregateRawRuns([raw(7, 2)], manifest());
    expect(compareSummaries(left, right)[0].deltaPreRunMedianMs).toBe(-3);
  });
});
