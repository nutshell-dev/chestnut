#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SCHEMA_VERSION = 4;
const DEFAULT_PROJECTS = ['fast', 'isolated'];

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseArgs(argv) {
  const options = { projects: [], workers: 4, warmup: 1, runs: 3, top: 50, filters: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--project') options.projects.push(argv[++index]);
    else if (arg === '--workers') options.workers = Number(argv[++index]);
    else if (arg === '--warmup') options.warmup = Number(argv[++index]);
    else if (arg === '--runs') options.runs = Number(argv[++index]);
    else if (arg === '--top') options.top = Number(argv[++index]);
    else if (arg === '--aggregate') options.aggregate = argv[++index];
    else if (arg === '--compare') {
      options.compare = [argv[++index], argv[++index]];
    } else if (arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else options.filters.push(arg);
  }
  if (options.projects.length === 0) options.projects = DEFAULT_PROJECTS;
  for (const [name, value, allowZero] of [
    ['workers', options.workers, false], ['warmup', options.warmup, true],
    ['runs', options.runs, false], ['top', options.top, false],
  ]) {
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`--${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
    }
  }
  return options;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : `unavailable (${result.status})`;
}

function comparableFields(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    nodeVersion: manifest.environment.nodeVersion,
    vitestVersion: manifest.environment.vitestVersion,
    os: manifest.environment.os,
    arch: manifest.environment.arch,
    cpuModel: manifest.environment.cpuModel,
    workers: manifest.options.workers,
    projects: manifest.options.projects,
    warmup: manifest.options.warmup,
    runs: manifest.options.runs,
    filters: manifest.options.filters,
    vitestConfigHash: manifest.environment.vitestConfigHash,
  };
}

function comparableKey(fields) {
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function calculateCapacityLoss(modules, workers) {
  const events = modules.flatMap((module) => [
    [module.inferredStartMs, 1],
    [module.endMs, -1],
  ]).sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  if (events.length === 0) {
    return { startupLossMs: 0, interiorLossMs: 0, tailLossMs: 0, interiorSlotGapPerFileMs: 0 };
  }

  const segments = [];
  let active = 0;
  let previousMs = events[0][0];
  for (const [atMs, delta] of events) {
    if (atMs > previousMs) segments.push({ startMs: previousMs, endMs: atMs, active });
    active += delta;
    previousMs = atMs;
  }
  const fullSegments = segments.filter((segment) => segment.active >= workers);
  const firstFullMs = fullSegments[0]?.startMs;
  const lastFullMs = fullSegments.at(-1)?.endMs;
  const wallEquivalentLoss = (selected) => selected.reduce(
    (sum, segment) => sum + Math.max(0, workers - segment.active) * (segment.endMs - segment.startMs),
    0,
  ) / workers;
  if (firstFullMs === undefined || lastFullMs === undefined) {
    const interiorLossMs = wallEquivalentLoss(segments);
    return {
      startupLossMs: 0,
      interiorLossMs,
      tailLossMs: 0,
      interiorSlotGapPerFileMs: modules.length > 0 ? interiorLossMs * workers / modules.length : 0,
    };
  }
  const startupLossMs = wallEquivalentLoss(segments.filter((segment) => segment.endMs <= firstFullMs));
  const interiorLossMs = wallEquivalentLoss(segments.filter(
    (segment) => segment.startMs >= firstFullMs && segment.endMs <= lastFullMs,
  ));
  const tailLossMs = wallEquivalentLoss(segments.filter((segment) => segment.startMs >= lastFullMs));
  return {
    startupLossMs,
    interiorLossMs,
    tailLossMs,
    interiorSlotGapPerFileMs: modules.length > 0 ? interiorLossMs * workers / modules.length : 0,
  };
}

function calculateRunBounds(run, workers, removedDependencyIds = new Set()) {
  const fanIn = new Map();
  for (const module of run.modules) {
    for (const dependency of module.imports) {
      fanIn.set(dependency.moduleId, (fanIn.get(dependency.moduleId) ?? 0) + 1);
    }
  }
  const projectNames = [...new Set(run.modules.map((module) => module.projectName))].sort();
  const projects = projectNames.map((projectName) => {
    const projectModules = run.modules.filter((module) => module.projectName === projectName);
    const jobs = projectModules.map((module) => {
      const removableMs = module.imports.reduce((sum, dependency) => {
        const engineeringCandidate = dependency.moduleId.startsWith('src/')
          && (fanIn.get(dependency.moduleId) ?? 0) >= 2;
        const remove = removedDependencyIds.has(dependency.moduleId)
          || (removedDependencyIds.has('*') && engineeringCandidate);
        return sum + (remove ? dependency.selfMs : 0);
      }, 0);
      return Math.max(0, module.preRunMs + module.testAndHooksMs - removableMs);
    });
    const workMs = jobs.reduce((sum, value) => sum + value, 0);
    const largestJobMs = Math.max(0, ...jobs);
    const lowerBoundMs = Math.max(workMs / workers, largestJobMs);
    const timeline = run.projects?.find((project) => project.projectName === projectName);
    const wallMs = timeline?.wallMs ?? 0;
    const capacityLoss = workMs / workers >= largestJobMs
      ? calculateCapacityLoss(projectModules, workers)
      : { startupLossMs: 0, interiorLossMs: 0, tailLossMs: 0, interiorSlotGapPerFileMs: 0 };
    return {
      projectName, workMs, largestJobMs, lowerBoundMs, wallMs,
      reporterWallMs: timeline?.reporterWallMs ?? 0,
      moduleSpanMs: timeline?.moduleSpanMs ?? 0,
      beforeModulesMs: timeline?.beforeModulesMs ?? 0,
      afterModulesMs: timeline?.afterModulesMs ?? 0,
      ...capacityLoss,
    };
  });
  return {
    projects,
    workMs: projects.reduce((sum, project) => sum + project.workMs, 0),
    lowerBoundMs: Math.max(0, ...projects.map((project) => project.lowerBoundMs)),
    wallMs: Math.max(0, ...projects.map((project) => project.wallMs)),
  };
}

function buildImportGraph(importEdges) {
  const adjacency = new Map();
  const importers = new Map();
  for (const { importerId, dependencyId } of importEdges ?? []) {
    if (!adjacency.has(importerId)) adjacency.set(importerId, new Set());
    adjacency.get(importerId).add(dependencyId);
    if (!importers.has(dependencyId)) importers.set(dependencyId, new Set());
    importers.get(dependencyId).add(importerId);
  }
  return { adjacency, importers };
}

function traverseImportGraph(adjacency, startId) {
  const queue = [startId];
  const predecessor = new Map([[startId, undefined]]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const dependencyId of [...(adjacency.get(current) ?? [])].sort()) {
      if (!predecessor.has(dependencyId)) {
        predecessor.set(dependencyId, current);
        queue.push(dependencyId);
      }
    }
  }
  return predecessor;
}

function reconstructPath(predecessor, targetId) {
  if (!predecessor.has(targetId)) return undefined;
  const reversed = [];
  for (let current = targetId; current !== undefined; current = predecessor.get(current)) reversed.push(current);
  return reversed.reverse();
}

function attributeRunDependencies(run, targetDependencyIds) {
  const attributions = new Map();
  const graph = buildImportGraph(run.importEdges);
  for (const testModule of run.modules) {
    const predecessor = traverseImportGraph(graph.adjacency, testModule.moduleId);
    for (const dependency of testModule.imports) {
      if (!targetDependencyIds.has(dependency.moduleId)) continue;
      if (!attributions.has(dependency.moduleId)) {
        attributions.set(dependency.moduleId, {
          resolvedFiles: 0, unresolvedFiles: 0, affectedTestFiles: new Set(),
          importers: new Map(), entries: new Map(), paths: new Map(),
        });
      }
      const attribution = attributions.get(dependency.moduleId);
      attribution.affectedTestFiles.add(testModule.moduleId);
      const importPaths = [...(graph.importers.get(dependency.moduleId) ?? [])].sort().flatMap((importerId) => {
        const path = reconstructPath(predecessor, importerId);
        return path ? [[...path, dependency.moduleId]] : [];
      });
      if (importPaths.length === 0) {
        attribution.unresolvedFiles += 1;
        continue;
      }
      attribution.resolvedFiles += 1;
      const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
      for (const importPath of importPaths) {
        increment(attribution.importers, importPath.at(-2));
        increment(attribution.paths, importPath.slice(1).join(' → '));
      }
      const shortestPath = importPaths.toSorted((left, right) => left.length - right.length
        || left.join('\0').localeCompare(right.join('\0')))[0];
      increment(attribution.entries, shortestPath[1]);
    }
  }
  return attributions;
}

function aggregateDependencyAttributions(rawRuns, targetDependencyIds) {
  const runs = rawRuns.map((run) => attributeRunDependencies(run, targetDependencyIds));
  const dependencyIds = new Set(runs.flatMap((run) => [...run.keys()]));
  const aggregateRanking = (samples, property, keyName) => {
    const keys = new Set(samples.flatMap((sample) => [...(sample?.[property].keys() ?? [])]));
    return [...keys].map((key) => ({
      [keyName]: key,
      fanInFiles: median(samples.map((sample) => sample?.[property].get(key) ?? 0)),
    })).filter((entry) => entry.fanInFiles > 0)
      .sort((left, right) => right.fanInFiles - left.fanInFiles
        || (keyName === 'path' ? left.path.split(' → ').length - right.path.split(' → ').length : 0)
        || left[keyName].localeCompare(right[keyName]));
  };
  return [...dependencyIds].map((moduleId) => {
    const samples = runs.map((run) => run.get(moduleId));
    return {
      moduleId,
      resolvedFiles: median(samples.map((sample) => sample?.resolvedFiles ?? 0)),
      unresolvedFiles: median(samples.map((sample) => sample?.unresolvedFiles ?? 0)),
      affectedTestFiles: [...new Set(samples.flatMap((sample) => [...(sample?.affectedTestFiles ?? [])]))].sort(),
      directImporters: aggregateRanking(samples, 'importers', 'moduleId'),
      entryModules: aggregateRanking(samples, 'entries', 'moduleId'),
      representativePaths: aggregateRanking(samples, 'paths', 'path'),
    };
  }).sort((left, right) => right.resolvedFiles - left.resolvedFiles || left.moduleId.localeCompare(right.moduleId));
}

export function aggregateRawRuns(rawRuns, manifest) {
  if (rawRuns.length === 0) throw new Error('No measured runs to aggregate');
  const expected = rawRuns[0].modules.map((module) => `${module.projectName}:${module.moduleId}`).sort();
  for (const [index, run] of rawRuns.entries()) {
    if (run.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported raw schema in run ${index + 1}`);
    const actual = run.modules.map((module) => `${module.projectName}:${module.moduleId}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Test module set differs in measured run ${index + 1}`);
    }
  }

  const files = expected.map((key) => {
    const samples = rawRuns.map((run) => run.modules.find(
      (module) => `${module.projectName}:${module.moduleId}` === key,
    ));
    const metric = (name) => samples.map((sample) => sample[name]);
    return {
      projectName: samples[0].projectName,
      moduleId: samples[0].moduleId,
      preRunMedianMs: median(metric('preRunMs')),
      preRunMinMs: Math.min(...metric('preRunMs')),
      preRunMaxMs: Math.max(...metric('preRunMs')),
      environmentSetupMedianMs: median(metric('environmentSetupMs')),
      prepareMedianMs: median(metric('prepareMs')),
      setupMedianMs: median(metric('setupMs')),
      collectMedianMs: median(metric('collectMs')),
      testAndHooksMedianMs: median(metric('testAndHooksMs')),
    };
  }).sort((a, b) => b.preRunMedianMs - a.preRunMedianMs || a.moduleId.localeCompare(b.moduleId));

  const dependencyIds = new Set(rawRuns.flatMap((run) => run.modules.flatMap(
    (module) => module.imports.map((dependency) => dependency.moduleId),
  )));
  const dependencies = [...dependencyIds].map((moduleId) => {
    const perRun = rawRuns.map((run) => {
      const entries = run.modules.flatMap((module) => module.imports.filter((entry) => entry.moduleId === moduleId));
      return {
        fanInFiles: entries.length,
        selfSumMs: entries.reduce((sum, entry) => sum + entry.selfMs, 0),
        selfValues: entries.map((entry) => entry.selfMs),
        totalValues: entries.map((entry) => entry.totalMs),
      };
    });
    return {
      moduleId,
      fanInFiles: median(perRun.map((run) => run.fanInFiles)),
      selfMedianMs: median(perRun.flatMap((run) => run.selfValues)),
      selfSumMedianMs: median(perRun.map((run) => run.selfSumMs)),
      totalImpactMedianMs: median(perRun.flatMap((run) => run.totalValues)),
    };
  }).sort((a, b) => b.selfSumMedianMs - a.selfSumMedianMs || b.fanInFiles - a.fanInFiles || a.moduleId.localeCompare(b.moduleId));

  const schedulingRuns = rawRuns.map((run) => calculateRunBounds(run, manifest.options.workers));
  const engineeringRuns = rawRuns.map((run) => calculateRunBounds(run, manifest.options.workers, new Set(['*'])));
  const projectNames = [...new Set(schedulingRuns.flatMap((run) => run.projects.map((project) => project.projectName)))].sort();
  const analysis = {
    actualWallMedianMs: median(schedulingRuns.map((run) => run.wallMs)),
    totalWorkMedianMs: median(schedulingRuns.map((run) => run.workMs)),
    schedulingLowerBoundMedianMs: median(schedulingRuns.map((run) => run.lowerBoundMs)),
    schedulingGapMedianMs: median(schedulingRuns.map((run) => run.wallMs - run.lowerBoundMs)),
    schedulingEfficiencyMedian: median(schedulingRuns.map((run) => run.wallMs > 0 ? run.lowerBoundMs / run.wallMs : 0)),
    engineeringLowerBoundMedianMs: median(engineeringRuns.map((run) => run.lowerBoundMs)),
    engineeringHeadroomMedianMs: median(engineeringRuns.map((run, index) => schedulingRuns[index].wallMs - run.lowerBoundMs)),
    assumptions: {
      fileWork: 'preRunMs + testAndHooksMs',
      scheduling: 'max(sum(fileWork)/workers, max(fileWork)) per project; concurrent projects use max',
      engineering: 'zero exclusive self time for src/** dependencies with fan-in >= 2',
    },
    projects: projectNames.map((projectName) => {
      const samples = schedulingRuns.map((run) => run.projects.find((project) => project.projectName === projectName));
      return {
        projectName,
        actualWallMedianMs: median(samples.map((sample) => sample.wallMs)),
        workMedianMs: median(samples.map((sample) => sample.workMs)),
        largestJobMedianMs: median(samples.map((sample) => sample.largestJobMs)),
        schedulingLowerBoundMedianMs: median(samples.map((sample) => sample.lowerBoundMs)),
        externalRunnerMedianMs: median(samples.map((sample) => sample.wallMs - sample.reporterWallMs)),
        reporterOverheadMedianMs: median(samples.map((sample) => sample.beforeModulesMs + sample.afterModulesMs)),
        moduleSpanMedianMs: median(samples.map((sample) => sample.moduleSpanMs)),
        moduleSchedulingLossMedianMs: median(samples.map((sample) => sample.moduleSpanMs - sample.lowerBoundMs)),
        moduleStartupLossMedianMs: median(samples.map((sample) => sample.startupLossMs)),
        moduleInteriorLossMedianMs: median(samples.map((sample) => sample.interiorLossMs)),
        moduleTailLossMedianMs: median(samples.map((sample) => sample.tailLossMs)),
        moduleUnattributedLossMedianMs: median(samples.map((sample) => (
          sample.moduleSpanMs - sample.lowerBoundMs
          - sample.startupLossMs - sample.interiorLossMs - sample.tailLossMs
        ))),
        interiorSlotGapPerFileMedianMs: median(samples.map((sample) => sample.interiorSlotGapPerFileMs)),
      };
    }),
  };
  const candidateSimulations = dependencies
    .filter((dependency) => dependency.moduleId.startsWith('src/') && dependency.fanInFiles >= 2)
    .map((dependency) => {
      const simulated = rawRuns.map((run) => calculateRunBounds(run, manifest.options.workers, new Set([dependency.moduleId])));
      return {
        moduleId: dependency.moduleId,
        fanInFiles: dependency.fanInFiles,
        workReductionMedianMs: dependency.selfSumMedianMs,
        simulatedLowerBoundMedianMs: median(simulated.map((run) => run.lowerBoundMs)),
        lowerBoundSavingsMedianMs: median(simulated.map((run, index) => schedulingRuns[index].lowerBoundMs - run.lowerBoundMs)),
      };
    })
    .sort((a, b) => b.lowerBoundSavingsMedianMs - a.lowerBoundSavingsMedianMs
      || b.workReductionMedianMs - a.workReductionMedianMs || a.moduleId.localeCompare(b.moduleId));

  const attributionLimit = manifest.options.top;
  const attributedDependencyIds = new Set([
    ...dependencies.slice(0, attributionLimit).map((dependency) => dependency.moduleId),
    ...candidateSimulations.slice(0, attributionLimit).map((candidate) => candidate.moduleId),
  ].filter((moduleId) => moduleId.startsWith('src/')
    && dependencies.find((dependency) => dependency.moduleId === moduleId)?.fanInFiles >= 2));
  const fields = comparableFields(manifest);
  return {
    schemaVersion: SCHEMA_VERSION,
    comparableKey: comparableKey(fields),
    comparableFields: fields,
    measuredRunCount: rawRuns.length,
    files,
    dependencies,
    dependencyAttributions: aggregateDependencyAttributions(rawRuns, attributedDependencyIds),
    analysis,
    candidateSimulations,
  };
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|');
}

function fixed(value) {
  return Number(value).toFixed(2);
}

export function renderReport(summary, top) {
  const lines = [
    '# Vitest test-cost baseline', '',
    `- Comparable key: \`${summary.comparableKey}\``,
    `- Measured runs: ${summary.measuredRunCount}`, '',
    '## Optimization space', '',
    '| Metric | Median |',
    '|---|---:|',
    `| Actual wall | ${fixed(summary.analysis.actualWallMedianMs)} ms |`,
    `| Total file work | ${fixed(summary.analysis.totalWorkMedianMs)} ms |`,
    `| Scheduling lower bound | ${fixed(summary.analysis.schedulingLowerBoundMedianMs)} ms |`,
    `| Scheduling gap | ${fixed(summary.analysis.schedulingGapMedianMs)} ms |`,
    `| Scheduling efficiency | ${fixed(summary.analysis.schedulingEfficiencyMedian * 100)}% |`,
    `| Optimistic engineering lower bound | ${fixed(summary.analysis.engineeringLowerBoundMedianMs)} ms |`,
    `| Optimistic engineering headroom | ${fixed(summary.analysis.engineeringHeadroomMedianMs)} ms |`, '',
    '> Scheduling lower bound is `max(sum(file work)/workers, largest file work)` per project; concurrent projects use the maximum.',
    '> Engineering lower bound removes exclusive self time for repeated `src/**` dependencies (fan-in >= 2). It is a direction-finding floor, not a forecast.', '',
    '### Per-project scheduling bounds', '',
    '| Project | Actual wall | External runner | Run edge overhead | Module span | Scheduling lower bound | Module scheduling loss |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  summary.analysis.projects.forEach((project) => lines.push(
    `| ${escapeCell(project.projectName)} | ${fixed(project.actualWallMedianMs)} | ${fixed(project.externalRunnerMedianMs)} | ${fixed(project.reporterOverheadMedianMs)} | ${fixed(project.moduleSpanMedianMs)} | ${fixed(project.schedulingLowerBoundMedianMs)} | ${fixed(project.moduleSchedulingLossMedianMs)} |`,
  ));
  lines.push('', '### Module scheduling loss decomposition', '',
    '| Project | Startup fill | Interior idle capacity | Tail drain | Unattributed | Interior slot gap / file |',
    '|---|---:|---:|---:|---:|---:|');
  summary.analysis.projects.forEach((project) => lines.push(
    `| ${escapeCell(project.projectName)} | ${fixed(project.moduleStartupLossMedianMs)} | ${fixed(project.moduleInteriorLossMedianMs)} | ${fixed(project.moduleTailLossMedianMs)} | ${fixed(project.moduleUnattributedLossMedianMs)} | ${fixed(project.interiorSlotGapPerFileMedianMs)} |`,
  ));
  lines.push('', '> Capacity loss integrates unused worker slots and reports their wall-time equivalent. Interior excludes initial pool fill and final drain.', '',
    '### Candidate optimization simulations', '',
    '| # | Dependency | Fan-in | Work removed | Simulated lower bound | Theoretical lower-bound saving |',
    '|---:|---|---:|---:|---:|---:|');
  summary.candidateSimulations.slice(0, top).forEach((candidate, index) => lines.push(
    `| ${index + 1} | ${escapeCell(candidate.moduleId)} | ${candidate.fanInFiles} | ${fixed(candidate.workReductionMedianMs)} | ${fixed(candidate.simulatedLowerBoundMedianMs)} | ${fixed(candidate.lowerBoundSavingsMedianMs)} |`,
  ));
  lines.push('', '> Each candidate simulation removes one dependency only; rows are not additive.', '',
    '## Highest per-file pre-run cost', '',
    '| # | Project | Test file | Pre-run median ms | Collect | Setup | Prepare | Environment | Test + hooks |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|');
  summary.files.slice(0, top).forEach((file, index) => lines.push(
    `| ${index + 1} | ${escapeCell(file.projectName)} | ${escapeCell(file.moduleId)} | ${fixed(file.preRunMedianMs)} | ${fixed(file.collectMedianMs)} | ${fixed(file.setupMedianMs)} | ${fixed(file.prepareMedianMs)} | ${fixed(file.environmentSetupMedianMs)} | ${fixed(file.testAndHooksMedianMs)} |`,
  ));
  lines.push('', '## Highest cumulative dependency self cost', '',
    '| # | Dependency | Fan-in files | Self sum median ms | Self median ms | Total impact median ms |',
    '|---:|---|---:|---:|---:|---:|');
  summary.dependencies.slice(0, top).forEach((dependency, index) => lines.push(
    `| ${index + 1} | ${escapeCell(dependency.moduleId)} | ${dependency.fanInFiles} | ${fixed(dependency.selfSumMedianMs)} | ${fixed(dependency.selfMedianMs)} | ${fixed(dependency.totalImpactMedianMs)} |`,
  ));
  lines.push('', '> `total impact` contains overlapping dependency subtrees and must not be summed across rows.', '');
  lines.push('## Transitive dependency path attribution', '',
    '| # | Dependency | Resolved files | Unresolved files | Top direct importer | Top test entry | Representative shortest path |',
    '|---:|---|---:|---:|---|---|---|');
  summary.dependencies.filter((dependency) => summary.dependencyAttributions.some(
    (entry) => entry.moduleId === dependency.moduleId,
  )).slice(0, top).forEach((dependency, index) => {
    const attribution = summary.dependencyAttributions.find((entry) => entry.moduleId === dependency.moduleId);
    const importer = attribution?.directImporters[0];
    const entry = attribution?.entryModules[0];
    const importPath = attribution?.representativePaths[0];
    lines.push(`| ${index + 1} | ${escapeCell(dependency.moduleId)} | ${attribution.resolvedFiles} | ${attribution.unresolvedFiles} | ${escapeCell(importer ? `${importer.moduleId} (${importer.fanInFiles})` : '—')} | ${escapeCell(entry ? `${entry.moduleId} (${entry.fanInFiles})` : '—')} | ${escapeCell(importPath ? `${importPath.path} (${importPath.fanInFiles})` : '—')} |`);
  });
  lines.push('', '> Paths are shortest paths from each test to every reachable direct importer through Vite’s resolved module graph. Importer/path counts are non-additive because one test can reach the dependency through multiple importers. Unresolved files are reported explicitly.', '');
  return lines.join('\n');
}

export function compareSummaries(left, right) {
  if (left.comparableKey !== right.comparableKey) {
    const differences = Object.keys({ ...left.comparableFields, ...right.comparableFields })
      .filter((key) => JSON.stringify(left.comparableFields[key]) !== JSON.stringify(right.comparableFields[key]));
    throw new Error(`Baselines are not comparable; differing fields: ${differences.join(', ')}`);
  }
  const before = new Map(left.files.map((file) => [`${file.projectName}:${file.moduleId}`, file]));
  return right.files.filter((file) => before.has(`${file.projectName}:${file.moduleId}`)).map((file) => {
    const old = before.get(`${file.projectName}:${file.moduleId}`);
    return { ...file, deltaPreRunMedianMs: file.preRunMedianMs - old.preRunMedianMs };
  }).sort((a, b) => a.deltaPreRunMedianMs - b.deltaPreRunMedianMs);
}

function mergeProjectRaw(projectPayloads, sample) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sample,
    importEdges: projectPayloads.flatMap((payload) => payload.importEdges ?? []),
    modules: projectPayloads.flatMap((payload) => payload.modules),
  };
}

function runProject(rootDir, runDir, label, project, workers, filters) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const rawPath = path.join(runDir, 'raw', `${label}-${project}.json`);
    const args = ['exec', 'vitest', 'run', '--config', '.config/vitest.config.ts', `--project=${project}`,
      '--reporter=default', '--reporter=./.config/vitest-cost-reporter.mjs', ...filters];
    const child = spawn('pnpm', args, {
      cwd: rootDir,
      env: {
        ...process.env,
        VITEST_MAX_THREADS: String(workers),
        CHESTNUT_COST_OUTPUT: rawPath,
        CHESTNUT_COST_PROJECT: project,
      },
    });
    const stdout = fs.createWriteStream(path.join(runDir, 'logs', `${label}-${project}.stdout.log`), { flags: 'wx' });
    const stderr = fs.createWriteStream(path.join(runDir, 'logs', `${label}-${project}.stderr.log`), { flags: 'wx' });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once('error', (error) => resolve({
      label, project, exitCode: null, signal: null, error: String(error), rawPath,
      wallMs: performance.now() - startedAt,
    }));
    child.once('close', (exitCode, signal) => {
      stdout.end();
      stderr.end();
      resolve({ label, project, exitCode, signal, rawPath, wallMs: performance.now() - startedAt });
    });
  });
}

async function runSample(rootDir, runDir, label, projects, workers, filters) {
  // Projects in one sample run concurrently, matching the normal `pnpm test`
  // resource shape while retaining explicit project ownership in each raw file.
  const processes = await Promise.all(projects.map(
    (project) => runProject(rootDir, runDir, label, project, workers, filters),
  ));
  const payloads = processes.filter((entry) => fs.existsSync(entry.rawPath))
    .map((entry) => JSON.parse(fs.readFileSync(entry.rawPath, 'utf8')));
  const combined = mergeProjectRaw(payloads, label);
  combined.projects = processes.map((entry) => {
    const payload = payloads.find((candidate) => candidate.run?.projectName === entry.project);
    return {
      projectName: entry.project,
      wallMs: entry.wallMs,
      reporterWallMs: payload?.run?.reporterWallMs ?? 0,
      moduleSpanMs: payload?.run?.moduleSpanMs ?? 0,
      beforeModulesMs: payload?.run?.beforeModulesMs ?? 0,
      afterModulesMs: payload?.run?.afterModulesMs ?? 0,
    };
  });
  fs.writeFileSync(path.join(runDir, 'runs', `${label}.json`), `${JSON.stringify(combined, null, 2)}\n`, { flag: 'wx' });
  return {
    combined,
    processes: processes.map(({ rawPath: _rawPath, ...entry }) => entry),
    ok: processes.every((entry) => entry.exitCode === 0) && payloads.length === projects.length,
  };
}

function usage() {
  return `Usage: pnpm bench:test-cost -- [options] [test filters...]\n\n` +
    `  --project NAME   repeatable; default fast + isolated\n` +
    `  --workers N      VITEST_MAX_THREADS (default 4)\n` +
    `  --warmup N       unmeasured warmup runs (default 1)\n` +
    `  --runs N         measured runs (default 3)\n` +
    `  --top N          Markdown rows per ranking (default 50)\n` +
    `  --aggregate DIR  rebuild summary/report from completed measured runs\n` +
    `  --compare A B    compare two summary.json files\n`;
}

export function aggregateRunDirectory(runDir, top) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  if (manifest.failed || !manifest.finishedAt) throw new Error('Cannot aggregate an incomplete or failed baseline run');
  const measured = fs.readdirSync(path.join(runDir, 'runs'))
    .filter((name) => /^run-\d+\.json$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]))
    .map((name) => JSON.parse(fs.readFileSync(path.join(runDir, 'runs', name), 'utf8')));
  if (measured.length !== manifest.options.runs) {
    throw new Error(`Expected ${manifest.options.runs} measured runs, found ${measured.length}`);
  }
  const summary = aggregateRawRuns(measured, manifest);
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(runDir, 'report.md'), renderReport(summary, top), { flag: 'wx' });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.compare) {
    const [leftPath, rightPath] = options.compare;
    const result = compareSummaries(
      JSON.parse(fs.readFileSync(leftPath, 'utf8')),
      JSON.parse(fs.readFileSync(rightPath, 'utf8')),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.aggregate) {
    const runDir = path.resolve(options.aggregate);
    aggregateRunDirectory(runDir, options.top);
    process.stdout.write(`${runDir}\n`);
    return;
  }

  const rootDir = process.cwd();
  const sha = commandOutput('git', ['rev-parse', '--short', 'HEAD']);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const runsRoot = path.resolve(rootDir, '.test-cost-runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  const runDir = path.join(runsRoot, `${stamp}_${sha}`);
  fs.mkdirSync(runDir, { recursive: false });
  fs.mkdirSync(path.join(runDir, 'raw'));
  fs.mkdirSync(path.join(runDir, 'runs'));
  fs.mkdirSync(path.join(runDir, 'logs'));

  const configBytes = fs.readFileSync(path.join(rootDir, '.config/vitest.config.ts'));
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    git: { sha: commandOutput('git', ['rev-parse', 'HEAD']), status: commandOutput('git', ['status', '--short']) },
    environment: {
      nodeVersion: process.version,
      pnpmVersion: commandOutput('pnpm', ['--version']),
      vitestVersion: commandOutput('pnpm', ['exec', 'vitest', '--version']),
      os: os.platform(), arch: os.arch(), cpuModel: os.cpus()[0]?.model ?? 'unknown', logicalCpuCount: os.cpus().length,
      vitestConfigHash: crypto.createHash('sha256').update(configBytes).digest('hex'),
    },
    options: { projects: options.projects, workers: options.workers, warmup: options.warmup, runs: options.runs, top: options.top, filters: options.filters },
    processes: [],
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

  let failed = false;
  for (let index = 1; index <= options.warmup; index += 1) {
    const result = await runSample(rootDir, runDir, `warmup-${index}`, options.projects, options.workers, options.filters);
    manifest.processes.push(...result.processes);
    failed ||= !result.ok;
  }
  const measured = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const result = await runSample(rootDir, runDir, `run-${index}`, options.projects, options.workers, options.filters);
    manifest.processes.push(...result.processes);
    measured.push(result.combined);
    failed ||= !result.ok;
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.failed = failed;
  fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (!failed) {
    const summary = aggregateRawRuns(measured, manifest);
    fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    fs.writeFileSync(path.join(runDir, 'report.md'), renderReport(summary, options.top), { flag: 'wx' });
  }
  process.stdout.write(`${runDir}\n`);
  if (failed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
