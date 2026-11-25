const INVARIANTS_FILE = 'tests/design/invariants.test.ts';
const INTEGRATION_PROJECTS = ['integration-process', 'integration-io'];
const DOCUMENTATION = /\.(?:md|mdx|rst|txt)$/i;

function isBuildInput(file) {
  return file.startsWith('src/')
    || file.startsWith('dist/')
    || file.startsWith('.config/')
    || file === 'package.json'
    || file === 'pnpm-lock.yaml'
    || file === 'pnpm-workspace.yaml'
    || file === 'tsconfig.json'
    || file === 'vitest.config.ts';
}

function isWideValidationInput(file) {
  return file.startsWith('tests/fixtures/')
    || file.startsWith('tests/utils/')
    || file.startsWith('.config/')
    || file.startsWith('scripts/')
    || file === 'package.json'
    || file === 'pnpm-lock.yaml'
    || file === 'pnpm-workspace.yaml'
    || file === 'tsconfig.json'
    || file === 'vitest.config.ts';
}

/**
 * Add tests for dependencies Vitest cannot infer from its module graph.
 * Every returned target is accompanied by the changed paths that triggered it.
 */
export function supplementalSelection(paths) {
  const changedPaths = [...new Set(paths)];
  const invariants = changedPaths.filter(file => /^(?:src|tests|\.config)\//.test(file));
  const integration = changedPaths.filter(isBuildInput);
  const wide = changedPaths.filter(isWideValidationInput);
  const unknown = changedPaths.filter(file => (
    !file.startsWith('src/')
    && !file.startsWith('tests/')
    && !file.startsWith('dist/')
    && !isWideValidationInput(file)
    && !DOCUMENTATION.test(file)
  ));
  const full = wide.length > 0 || unknown.length > 0;
  const files = invariants.length > 0 ? [INVARIANTS_FILE] : [];
  const projects = integration.length > 0 ? [...INTEGRATION_PROJECTS] : [];
  const evidence = [];

  if (invariants.length > 0) {
    evidence.push({ rule: 'repository-invariants', paths: invariants, files });
  }
  if (integration.length > 0) {
    evidence.push({ rule: 'runtime-or-build-input', paths: integration, projects, build: true });
  }
  if (wide.length > 0) {
    evidence.push({ rule: 'configuration-fixture-or-test-infrastructure', paths: wide, full: true });
  }
  if (unknown.length > 0) {
    evidence.push({ rule: 'unclassified-non-documentation', paths: unknown, full: true });
  }

  return {
    files,
    projects,
    build: full || integration.length > 0,
    full,
    evidence,
    limitations: [
      'Explicit rules cover known non-import dependencies; unrecognized dynamic dependencies remain a differential-selection limitation.',
    ],
  };
}
