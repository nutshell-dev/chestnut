import * as fs from 'node:fs';
import * as path from 'node:path';
import { withYamlConfigLockAsync } from '../../../../src/foundation/config-store/index.js';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';

interface Scenario {
  configPath: string;
  barrierDir: string;
  mode: 'hold' | 'exit-with-lock';
}

// Only a hang bound; readiness and release are file barriers, not timing races.
const HANG_LIMIT_MS = 30_000;
const BARRIER_POLL_MS = 5;

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error('usage: lock-holder <scenario.json>');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario;
const readyPath = path.join(scenario.barrierDir, 'ready.json');
const releasePath = path.join(scenario.barrierDir, 'release');

async function waitForRelease(): Promise<void> {
  const deadline = Date.now() + HANG_LIMIT_MS;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error(`release barrier timeout: ${releasePath}`);
    await new Promise<void>(resolve => setTimeout(resolve, BARRIER_POLL_MS));
  }
}

try {
  await withYamlConfigLockAsync({
    fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
  }, scenario.configPath, async () => {
    fs.writeFileSync(readyPath, JSON.stringify({
      pid: process.pid,
      lockRaw: fs.readFileSync(scenario.configPath + '.lock', 'utf8'),
    }));
    if (scenario.mode === 'exit-with-lock') process.exit(0);
    await waitForRelease();
    fs.writeFileSync(path.join(scenario.barrierDir, 'completed'), 'completed');
  }, { acquireTimeoutMs: HANG_LIMIT_MS, staleMs: 0, pollMs: BARRIER_POLL_MS });
  process.stdout.write('LOCK_HOLDER|ok\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
