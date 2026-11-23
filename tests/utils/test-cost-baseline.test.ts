import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The production tool is plain ESM so Node can execute it without a TS loader.
// @ts-expect-error No declaration file is intentionally emitted for this CLI module.
import {
  aggregateRawRuns, aggregateRunDirectory, compareSummaries, parseArgs, renderReport,
} from '../../scripts/test-cost-baseline.mjs';
import { cleanupTempDirSync, createTrackedTempDirSync } from './temp.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) cleanupTempDirSync(tempDir);
});

function makeTempDir(prefix: string): string {
  const tempDir = createTrackedTempDirSync(prefix);
  tempDirs.push(tempDir);
  return tempDir;
}

function raw(preRun: number, dependencySelf: number, actualWorkers = 4) {
  return {
    schemaVersion: 5,
    importEdges: [{ importerId: 'tests/a.test.ts', dependencyId: 'src/shared.ts' }],
    projects: [{
      projectName: 'fast', wallMs: 40, reporterWallMs: 30,
      moduleSpanMs: 24, beforeModulesMs: 3, afterModulesMs: 3,
      workerConfiguration: { maxWorkers: actualWorkers, pool: 'forks', groupOrder: 0 },
    }],
    modules: [{
      projectName: 'fast', moduleId: 'tests/a.test.ts',
      environmentSetupMs: 1, prepareMs: 2, setupMs: 3,
      collectMs: preRun - 6, preRunMs: preRun, testAndHooksMs: 4,
      inferredStartMs: 3, endMs: 3 + preRun + 4,
      imports: [{ moduleId: 'src/shared.ts', selfMs: dependencySelf, totalMs: dependencySelf + 2 }],
    }],
  };
}

function manifest(workers = 4, actualWorkers = workers) {
  return {
    schemaVersion: 5,
    environment: {
      nodeVersion: 'v20', vitestVersion: 'vitest/3.2.4', os: 'darwin', arch: 'arm64',
      cpuModel: 'fixture', vitestConfigHash: 'abc',
    },
    options: { workers, projects: ['fast'], warmup: 1, runs: 3, filters: [] },
    effectiveProjects: [{
      projectName: 'fast',
      workerConfiguration: { maxWorkers: actualWorkers, pool: 'forks', groupOrder: 0 },
    }],
    samplingMode: 'independent-project-processes',
  };
}

describe('test-cost baseline project selection', () => {
  it('includes resource in default sampling without changing explicit project selection', () => {
    expect(parseArgs([]).projects).toEqual(['fast', 'resource', 'isolated']);
    expect(parseArgs(['--project', 'fast']).projects).toEqual(['fast']);
    expect(parseArgs(['--project', 'integration-process']).projects).toEqual(['integration-process']);
    expect(() => parseArgs(['--project', 'fast', '--project', 'fast'])).toThrow(/Duplicate --project/);
  });

  it('keeps resource on default/fast/smoke selectors and integration scoped to integration projects', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const selectedProjects = (scriptName: string) =>
      [...packageJson.scripts[scriptName].matchAll(/--project=([^\s]+)/g)].map(match => match[1]);

    const defaultUnitProjects = ['fast', 'resource', 'isolated'];
    expect(selectedProjects('test')).toEqual(defaultUnitProjects);
    expect(selectedProjects('test:fast')).toEqual(defaultUnitProjects);
    expect(selectedProjects('test:smoke')).toEqual(defaultUnitProjects);
    expect(selectedProjects('test:run')).toEqual([
      'fast', 'resource', 'isolated', 'arch-compile', 'integration-process', 'integration-io',
    ]);
    expect(selectedProjects('test:integration')).toEqual(['integration-process', 'integration-io']);
  });
});

describe('test-cost baseline aggregation', () => {
  it('uses medians and ranks dependency exclusive cumulative cost', () => {
    const summary = aggregateRawRuns([raw(10, 2), raw(30, 6), raw(20, 4)], manifest());
    expect(summary.files[0]).toMatchObject({ preRunMedianMs: 20, collectMedianMs: 14 });
    expect(summary.dependencies[0]).toMatchObject({
      moduleId: 'src/shared.ts', fanInFiles: 1, selfMedianMs: 4, selfSumMedianMs: 4,
    });
    expect(summary.analysis).toMatchObject({
      actualWallMedianMs: 40,
      totalWorkMedianMs: 24,
      schedulingLowerBoundMedianMs: 24,
      schedulingGapMedianMs: 16,
      schedulingEfficiencyMedian: 0.6,
    });
    expect(summary.analysis.projects[0]).toMatchObject({
      externalRunnerMedianMs: 10,
      reporterOverheadMedianMs: 6,
      moduleSpanMedianMs: 24,
      moduleSchedulingLossMedianMs: 0,
    });
    expect(renderReport(summary, 1)).toContain('Scheduling lower bound');
    expect(renderReport(summary, 1)).toContain('Interior idle capacity');
    expect(renderReport(summary, 1)).toContain('src/shared.ts');
    expect(summary.dependencyAttributions).toEqual([]);
  });

  it('uses resolved workers rather than the request for three-task capacity math', () => {
    const fixture = raw(10, 0, 2);
    fixture.modules = ['a', 'b', 'c'].map((name) => ({
      ...fixture.modules[0], moduleId: `tests/${name}.test.ts`,
    }));
    const summary = aggregateRawRuns([fixture], manifest(8, 2));

    expect(summary.analysis).toMatchObject({
      totalWorkMedianMs: 42,
      schedulingLowerBoundMedianMs: 21,
    });
    expect(summary.analysis.projects[0].largestJobMedianMs).toBe(14);
    expect(summary.comparableFields).toMatchObject({
      workers: 8,
      effectiveProjects: [{ projectName: 'fast', workerConfiguration: { maxWorkers: 2 } }],
      samplingMode: 'independent-project-processes',
    });
    const report = renderReport(summary, 1);
    expect(report).toContain('Requested max workers per project process: 8');
    expect(report).toContain('| fast | 8 | 2 | forks | 0 |');
    expect(report).toContain('independent project processes');
    expect(report).toContain('not regular `test:run` scheduling');
  });

  it('decomposes worker capacity loss into interior gaps', () => {
    const fixture = raw(6, 0, 2);
    fixture.projects[0].moduleSpanMs = 22;
    fixture.modules = [
      { ...fixture.modules[0], moduleId: 'tests/a.test.ts', inferredStartMs: 0, endMs: 10 },
      { ...fixture.modules[0], moduleId: 'tests/b.test.ts', inferredStartMs: 0, endMs: 10 },
      { ...fixture.modules[0], moduleId: 'tests/c.test.ts', inferredStartMs: 12, endMs: 22 },
      { ...fixture.modules[0], moduleId: 'tests/d.test.ts', inferredStartMs: 12, endMs: 22 },
    ];
    const project = aggregateRawRuns([fixture], manifest(2)).analysis.projects[0];
    expect(project).toMatchObject({
      moduleStartupLossMedianMs: 0,
      moduleInteriorLossMedianMs: 2,
      moduleTailLossMedianMs: 0,
      moduleUnattributedLossMedianMs: 0,
      interiorSlotGapPerFileMedianMs: 1,
    });
  });

  it('uses resolved workers for scheduling, engineering and dependency simulations', () => {
    const fixture = raw(20, 4, 2);
    fixture.modules.push({
      ...fixture.modules[0],
      moduleId: 'tests/b.test.ts',
      imports: [{ moduleId: 'src/shared.ts', selfMs: 6, totalMs: 100 }],
    });
    fixture.modules.push({
      ...fixture.modules[0],
      moduleId: 'tests/c.test.ts',
      imports: [{ moduleId: 'src/shared.ts', selfMs: 0, totalMs: 100 }],
    });
    const summary = aggregateRawRuns([fixture], manifest(8, 2));

    expect(summary.analysis.schedulingLowerBoundMedianMs).toBe(36);
    expect(summary.analysis.engineeringLowerBoundMedianMs).toBe(31);
    expect(summary.candidateSimulations[0]).toMatchObject({
      moduleId: 'src/shared.ts',
      workReductionMedianMs: 10,
      simulatedLowerBoundMedianMs: 31,
      lowerBoundSavingsMedianMs: 5,
    });
  });

  it('attributes shortest transitive paths and reports graph misses', () => {
    const fixture = raw(20, 4, 2);
    fixture.importEdges = [
      { importerId: 'tests/a.test.ts', dependencyId: 'src/entry.ts' },
      { importerId: 'src/entry.ts', dependencyId: 'src/long-way.ts' },
      { importerId: 'src/long-way.ts', dependencyId: 'src/shared.ts' },
      { importerId: 'src/entry.ts', dependencyId: 'src/shared.ts' },
    ];
    fixture.modules.push({
      ...fixture.modules[0], moduleId: 'tests/unresolved.test.ts',
    });

    const attribution = aggregateRawRuns([fixture], manifest(2)).dependencyAttributions[0];
    expect(attribution).toMatchObject({
      resolvedFiles: 1,
      unresolvedFiles: 1,
      affectedTestFiles: ['tests/a.test.ts', 'tests/unresolved.test.ts'],
      entryModules: [{ moduleId: 'src/entry.ts', fanInFiles: 1 }],
      representativePaths: [
        { path: 'src/entry.ts → src/shared.ts', fanInFiles: 1 },
        { path: 'src/entry.ts → src/long-way.ts → src/shared.ts', fanInFiles: 1 },
      ],
    });
    expect(attribution.directImporters).toEqual([
      { moduleId: 'src/entry.ts', fanInFiles: 1 },
      { moduleId: 'src/long-way.ts', fanInFiles: 1 },
    ]);
  });

  it('rejects duplicate and missing actual project worker facts', () => {
    const duplicate = raw(10, 2);
    duplicate.projects.push({ ...duplicate.projects[0] });
    expect(() => aggregateRawRuns([duplicate], manifest())).toThrow(/Duplicate actual project worker facts/);

    const missing = raw(10, 2);
    Reflect.deleteProperty(missing.projects[0], 'workerConfiguration');
    expect(() => aggregateRawRuns([missing], manifest())).toThrow(/actual worker configuration/);
  });

  it('rejects conflicting actual configurations across measured runs', () => {
    expect(() => aggregateRawRuns([
      raw(10, 2, 2), raw(10, 2, 4),
    ], manifest(8, 2))).toThrow(/worker configuration differs/);
  });

  it('rejects measured runs with different module sets', () => {
    const changed = raw(10, 2);
    changed.modules[0].moduleId = 'tests/b.test.ts';
    expect(() => aggregateRawRuns([raw(10, 2), changed], manifest())).toThrow(/module set differs/);
  });

  it('refuses comparisons when environment-affecting fields differ', () => {
    const left = aggregateRawRuns([raw(10, 2, 2)], manifest(2));
    const right = aggregateRawRuns([raw(9, 2)], manifest(4));
    expect(() => compareSummaries(left, right)).toThrow(/workers/);
  });

  it('refuses comparisons with the same request but different resolved workers', () => {
    const left = aggregateRawRuns([raw(10, 2, 2)], manifest(8, 2));
    const right = aggregateRawRuns([raw(10, 2, 4)], manifest(8, 4));
    expect(() => compareSummaries(left, right)).toThrow(/effectiveProjects/);
  });

  it('rejects old schemas and missing facts even when comparable keys match', () => {
    const oldLeft = aggregateRawRuns([raw(10, 2)], manifest());
    const oldRight = aggregateRawRuns([raw(9, 2)], manifest());
    oldLeft.schemaVersion = 4;
    oldRight.schemaVersion = 4;
    expect(oldLeft.comparableKey).toBe(oldRight.comparableKey);
    expect(() => compareSummaries(oldLeft, oldRight)).toThrow(/summary schema/);

    const missingLeft = aggregateRawRuns([raw(10, 2)], manifest());
    const missingRight = aggregateRawRuns([raw(9, 2)], manifest());
    Reflect.deleteProperty(missingLeft.comparableFields, 'effectiveProjects');
    Reflect.deleteProperty(missingRight.comparableFields, 'effectiveProjects');
    expect(() => compareSummaries(missingLeft, missingRight)).toThrow(/actual project worker facts/);
  });

  it('reports per-file deltas for comparable baselines', () => {
    const left = aggregateRawRuns([raw(10, 2)], manifest());
    const right = aggregateRawRuns([raw(7, 2)], manifest());
    expect(compareSummaries(left, right)[0].deltaPreRunMedianMs).toBe(-3);
  });

  it('rejects an old run directory without changing any existing bytes', () => {
    const runDir = makeTempDir('test-cost-legacy-aggregate-');
    fs.mkdirSync(path.join(runDir, 'runs'));
    const legacyManifest = manifest();
    legacyManifest.schemaVersion = 4;
    Reflect.deleteProperty(legacyManifest, 'effectiveProjects');
    Reflect.deleteProperty(legacyManifest, 'samplingMode');
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      ...legacyManifest, finishedAt: '2026-07-16T00:00:00.000Z', failed: false,
    }));
    for (let index = 1; index <= 3; index += 1) {
      const legacyRaw = raw(index * 10, index * 2);
      legacyRaw.schemaVersion = 4;
      Reflect.deleteProperty(legacyRaw.projects[0], 'workerConfiguration');
      fs.writeFileSync(path.join(runDir, `runs/run-${index}.json`), JSON.stringify(legacyRaw));
    }
    fs.writeFileSync(path.join(runDir, 'summary.json'), 'legacy summary bytes\n');
    fs.writeFileSync(path.join(runDir, 'report.md'), 'legacy report bytes\n');
    const names = [
      'manifest.json', 'runs/run-1.json', 'runs/run-2.json', 'runs/run-3.json',
      'summary.json', 'report.md',
    ];
    const before = names.map((name) => fs.readFileSync(path.join(runDir, name)));

    expect(() => aggregateRunDirectory(runDir, 1)).toThrow(/manifest schema/);
    names.forEach((name, index) => {
      expect(fs.readFileSync(path.join(runDir, name))).toEqual(before[index]);
    });
  });

  it('rejects warmup and measured worker conflicts before writing reports', () => {
    const runDir = makeTempDir('test-cost-warmup-conflict-');
    fs.mkdirSync(path.join(runDir, 'runs'));
    const fixtureManifest = manifest(8, 2);
    fixtureManifest.options.runs = 1;
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      ...fixtureManifest, finishedAt: '2026-07-16T00:00:00.000Z', failed: false,
    }));
    fs.writeFileSync(path.join(runDir, 'runs/warmup-1.json'), JSON.stringify(raw(10, 2, 4)));
    fs.writeFileSync(path.join(runDir, 'runs/run-1.json'), JSON.stringify(raw(10, 2, 2)));

    expect(() => aggregateRunDirectory(runDir, 1)).toThrow(/worker configuration differs/);
    expect(fs.existsSync(path.join(runDir, 'summary.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'report.md'))).toBe(false);
  });

  it('rebuilds reports from a completed interrupted run directory', () => {
    const runDir = makeTempDir('test-cost-aggregate-');
    fs.mkdirSync(path.join(runDir, 'runs'));
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      ...manifest(), finishedAt: '2026-07-16T00:00:00.000Z', failed: false,
    }));
    fs.writeFileSync(path.join(runDir, 'runs/warmup-1.json'), JSON.stringify(raw(10, 2)));
    fs.writeFileSync(path.join(runDir, 'runs/run-1.json'), JSON.stringify(raw(10, 2)));
    fs.writeFileSync(path.join(runDir, 'runs/run-2.json'), JSON.stringify(raw(20, 4)));
    fs.writeFileSync(path.join(runDir, 'runs/run-3.json'), JSON.stringify(raw(30, 6)));

    aggregateRunDirectory(runDir, 1);

    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8')).measuredRunCount).toBe(3);
    expect(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8')).toContain('Vitest test-cost baseline');
  });
});
