import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 4;

function normalizeId(id, cwd) {
  const clean = id.split('?')[0].replace(/^\/@fs\//, '/').replaceAll('\\', '/');
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
}

function finite(value, field, moduleId) {
  if (!Number.isFinite(value)) {
    throw new Error(`Vitest diagnostic ${field} missing for ${moduleId}`);
  }
  return value;
}

export default class VitestCostReporter {
  vitest;
  runStartedAt = 0;
  moduleStartedAt = new Map();
  moduleEndedAt = new Map();

  onInit(vitest) {
    this.vitest = vitest;
  }

  onTestRunStart() {
    this.runStartedAt = performance.now();
  }

  onTestModuleStart(testModule) {
    this.moduleStartedAt.set(testModule.moduleId, performance.now());
  }

  onTestModuleEnd(testModule) {
    this.moduleEndedAt.set(testModule.moduleId, performance.now());
  }

  async onTestRunEnd(testModules, unhandledErrors, reason) {
    const output = process.env.CHESTNUT_COST_OUTPUT;
    const projectName = process.env.CHESTNUT_COST_PROJECT;
    if (!output || !projectName) {
      throw new Error('CHESTNUT_COST_OUTPUT and CHESTNUT_COST_PROJECT are required');
    }

    const cwd = process.cwd();
    const runEndedAt = performance.now();
    const modules = [...testModules].map((testModule) => {
      const moduleId = normalizeId(testModule.moduleId, cwd);
      const diagnostic = testModule.diagnostic();
      const environmentSetupMs = finite(diagnostic.environmentSetupDuration, 'environmentSetupDuration', moduleId);
      const prepareMs = finite(diagnostic.prepareDuration, 'prepareDuration', moduleId);
      const setupMs = finite(diagnostic.setupDuration, 'setupDuration', moduleId);
      const collectMs = finite(diagnostic.collectDuration, 'collectDuration', moduleId);
      const testAndHooksMs = finite(diagnostic.duration, 'duration', moduleId);
      const testStartedAt = finite(this.moduleStartedAt.get(testModule.moduleId), 'timeline.start', moduleId);
      const moduleEndedAt = finite(this.moduleEndedAt.get(testModule.moduleId), 'timeline.end', moduleId);
      const inferredStartMs = testStartedAt - this.runStartedAt - (environmentSetupMs + prepareMs + setupMs + collectMs);
      const endMs = moduleEndedAt - this.runStartedAt;
      const imports = Object.entries(diagnostic.importDurations ?? {})
        .map(([id, duration]) => ({
          moduleId: normalizeId(id, cwd),
          selfMs: finite(duration.selfTime, 'import.selfTime', moduleId),
          totalMs: finite(duration.totalTime, 'import.totalTime', moduleId),
        }))
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId));

      return {
        moduleId,
        projectName,
        state: testModule.state(),
        environmentSetupMs,
        prepareMs,
        setupMs,
        collectMs,
        testAndHooksMs,
        preRunMs: environmentSetupMs + prepareMs + setupMs + collectMs,
        inferredStartMs,
        endMs,
        imports,
      };
    }).sort((a, b) => a.moduleId.localeCompare(b.moduleId));

    const earliestModuleMs = Math.min(...modules.map((module) => module.inferredStartMs));
    const latestModuleMs = Math.max(...modules.map((module) => module.endMs));
    const project = this.vitest?.projects.find((candidate) => candidate.name === projectName)
      ?? this.vitest?.projects[0];
    const importEdges = [...(project?.vite.moduleGraph.idToModuleMap.values() ?? [])]
      .flatMap((importer) => [...importer.importedModules].map((dependency) => ({
        importerId: normalizeId(importer.id ?? importer.url, cwd),
        dependencyId: normalizeId(dependency.id ?? dependency.url, cwd),
      })))
      .filter((edge) => edge.importerId !== edge.dependencyId)
      .sort((left, right) => left.importerId.localeCompare(right.importerId)
        || left.dependencyId.localeCompare(right.dependencyId));
    const reporterWallMs = runEndedAt - this.runStartedAt;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      run: {
        projectName,
        reason,
        unhandledErrorCount: unhandledErrors.length,
        reporterWallMs,
        moduleSpanMs: latestModuleMs - earliestModuleMs,
        beforeModulesMs: earliestModuleMs,
        afterModulesMs: reporterWallMs - latestModuleMs,
      },
      importEdges,
      modules,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, output);
  }
}
