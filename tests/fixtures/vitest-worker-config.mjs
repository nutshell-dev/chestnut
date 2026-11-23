import { createRequire } from 'node:module';
import { createVitest } from 'vitest/node';

const require = createRequire(import.meta.url);
const options = {
  root: process.cwd(),
  config: '.config/vitest.config.ts',
  watch: false,
};

for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--max-workers=')) {
    const value = argument.slice('--max-workers='.length);
    options.maxWorkers = value.endsWith('%') ? value : Number(value);
  } else if (argument === '--no-file-parallelism') {
    options.fileParallelism = false;
  } else {
    throw new Error(`Unknown fixture argument: ${argument}`);
  }
}

const context = await createVitest('test', options);
try {
  const specifications = await context.globTestSpecifications();
  const projects = context.projects.map(project => ({
    name: project.name,
    maxWorkers: project.config.maxWorkers,
    pool: project.config.pool,
    isolate: project.config.isolate,
    groupOrder: project.config.sequence.groupOrder,
    fileParallelism: project.config.fileParallelism,
    testTimeout: project.config.testTimeout,
    hookTimeout: project.config.hookTimeout,
  }));
  const files = specifications
    .map(specification => [specification.project.name, specification.moduleId])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  process.stdout.write(`${JSON.stringify({
    vitestVersion: require('vitest/package.json').version,
    projects,
    files,
  })}\n`);
} finally {
  await context.close();
}
