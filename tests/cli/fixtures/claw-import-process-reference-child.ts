/**
 * Phase 2116 Step C：在真实子进程中运行生产 importCommand。
 *
 * 仅包装 destParent FileSystem.writeAtomicSync：初始/manifest claim 真正落盘后，
 * 通过原子 ready 文件通知父进程，并在 release 文件屏障上同步等待。release 后
 * 直接退出，保留该中断点的真实 claim/staging 供父进程验证活 holder 与恢复。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { importCommand } from '../../../src/cli/commands/claw-import.js';
import type { ClawCommandDeps } from '../../../src/cli/commands/claw-command-deps.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

interface Scenario {
  rootDir: string;
  source: string;
  clawName: string;
  destParent: string;
  claimRel: string;
  barrierDir: string;
  pauseAt: 'initial' | 'manifest';
}

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error('usage: claw-import-process-reference-child <scenario.json>');
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario;
process.env.CHESTNUT_ROOT = scenario.rootDir;

// These waits are only hang bounds; ready/release files determine all ordering.
const HANG_LIMIT_MS = 30_000;
const BARRIER_POLL_MS = 5;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const readyPath = path.join(scenario.barrierDir, 'ready.json');
const releasePath = path.join(scenario.barrierDir, 'release');
let paused = false;

function publishReady(): void {
  const temporary = `${readyPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, pauseAt: scenario.pauseAt }));
  fs.renameSync(temporary, readyPath);
}

function waitForReleaseAndExit(): void {
  const deadline = Date.now() + HANG_LIMIT_MS;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error(`release barrier timeout: ${releasePath}`);
    Atomics.wait(waitCell, 0, 0, BARRIER_POLL_MS);
  }
  // Simulate interruption after the selected claim became visible on disk.
  process.exit(0);
}

function fsFactory(baseDir: string): FileSystem {
  const real = new NodeFileSystem({ baseDir });
  if (path.resolve(baseDir) !== path.resolve(scenario.destParent)) return real;
  const originalWrite = real.writeAtomicSync.bind(real);
  real.writeAtomicSync = (targetPath, content) => {
    const result = originalWrite(targetPath, content);
    if (!paused && targetPath === scenario.claimRel) {
      const claim = JSON.parse(content) as { manifestHash?: unknown };
      const hasManifest = typeof claim.manifestHash === 'string';
      if ((scenario.pauseAt === 'initial' && !hasManifest)
          || (scenario.pauseAt === 'manifest' && hasManifest)) {
        paused = true;
        publishReady();
        waitForReleaseAndExit();
      }
    }
    return result;
  };
  return real;
}

type RootConfig = ClawCommandDeps['rootConfig'];
const rootConfig: RootConfig = {
  loadGlobal: () => ({}) as ReturnType<RootConfig['loadGlobal']>,
  loadClaw: () => ({}) as NonNullable<ReturnType<RootConfig['loadClaw']>>,
};

try {
  await importCommand({ fsFactory, rootConfig }, scenario.source, scenario.clawName);
  process.stdout.write('IMPORT_PROCESS_REFERENCE|completed\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
