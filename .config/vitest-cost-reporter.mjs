import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 2;

function normalizeId(id, cwd) {
  const clean = id.split('?')[0].replaceAll('\\', '/');
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
  async onTestRunEnd(testModules, unhandledErrors, reason) {
    const output = process.env.CHESTNUT_COST_OUTPUT;
    const projectName = process.env.CHESTNUT_COST_PROJECT;
    if (!output || !projectName) {
      throw new Error('CHESTNUT_COST_OUTPUT and CHESTNUT_COST_PROJECT are required');
    }

    const cwd = process.cwd();
    const modules = [...testModules].map((testModule) => {
      const moduleId = normalizeId(testModule.moduleId, cwd);
      const diagnostic = testModule.diagnostic();
      const environmentSetupMs = finite(diagnostic.environmentSetupDuration, 'environmentSetupDuration', moduleId);
      const prepareMs = finite(diagnostic.prepareDuration, 'prepareDuration', moduleId);
      const setupMs = finite(diagnostic.setupDuration, 'setupDuration', moduleId);
      const collectMs = finite(diagnostic.collectDuration, 'collectDuration', moduleId);
      const testAndHooksMs = finite(diagnostic.duration, 'duration', moduleId);
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
        imports,
      };
    }).sort((a, b) => a.moduleId.localeCompare(b.moduleId));

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      run: {
        projectName,
        reason,
        unhandledErrorCount: unhandledErrors.length,
      },
      modules,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, output);
  }
}
