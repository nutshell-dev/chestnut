import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import { withSkillStateLock } from '../../../../src/foundation/skill-system/state-lock.js';

interface Scenario {
  stateDir: string;
  barrierDir: string;
  mode: 'hold' | 'exit-with-lock';
}

// Readiness and release are file barriers; these timers are only hang bounds.
const HANG_LIMIT_MS = 30_000;
const BARRIER_POLL_MS = 5;

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error('usage: state-lock-holder <scenario.json>');
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
  await withSkillStateLock(new NodeFileSystem({ baseDir: scenario.stateDir }), async () => {
    fs.writeFileSync(readyPath, JSON.stringify({
      pid: process.pid,
      lockRaw: fs.readFileSync(path.join(scenario.stateDir, 'state.lock'), 'utf8'),
    }));
    if (scenario.mode === 'exit-with-lock') process.exit(0);
    await waitForRelease();
    fs.writeFileSync(path.join(scenario.barrierDir, 'completed'), 'completed');
  });
  process.stdout.write('STATE_LOCK_HOLDER|ok\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
