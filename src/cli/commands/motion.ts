/**
 * Motion CLI commands
 *
 * Commands:
 * - motion init: create the .clawforum/motion/ directory and write template files
 * - motion chat: start an interactive chat session
 *
 * Motion is the manager; it manages other Claws by calling the CLI via exec and has no dedicated tools.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadGlobalConfig, getNamedSubrootDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';

import { runChatViewport } from './chat-viewport.js';
import { CliError } from '../errors.js';
import { Snapshot } from '../../foundation/snapshot/index.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../assembly/index.js';
import { CLAWS_DIR, getWorkspaceRoot, resolveDaemonEntry } from '../../foundation/paths.js';
import { DAEMON_LOG } from '../../daemon/constants.js';
import { TASKS_SYNC_EXEC_DIR } from '../../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../../foundation/file-tool/index.js';
import { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME } from '../../foundation/skill-system/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { type ClawDir, makeClawDir } from '../../foundation/identity/index.js';

// Get current file directory (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template file names (supports both build artifacts and source directory)
const TEMPLATE_FILES = ['AGENTS.md', 'SOUL.md', 'AUTH_POLICY.md', 'HEARTBEAT.md'];

/**
 * Read template file content (falls back from build artifacts to source directory)
 */
async function readTemplate(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string): Promise<string> {
  // Try dist path first
  const distFs = deps.fsFactory(__dirname);
  try {
    return distFs.readSync(path.join('templates', 'motion', name));
  } catch {
    // Fall back to src path (during development)
    const srcPath = path.join(__dirname, '..', '..', '..', '..', 'src', 'cli', 'commands', 'templates', 'motion', name);
    const srcFs = deps.fsFactory(path.dirname(srcPath));
    return srcFs.readSync(path.basename(srcPath));
  }
}

/**
 * Copy directory recursively
 */
async function copyDir(deps: { fsFactory: (baseDir: string) => FileSystem }, src: string, dest: string): Promise<void> {
  const srcFs = deps.fsFactory(src);
  const destFs = deps.fsFactory(dest);
  await destFs.ensureDir('.');
  const entries = await srcFs.list('.');
  for (const entry of entries) {
    const srcRel = entry.name;
    const destRel = entry.name;
    if (entry.isDirectory) {
      await copyDir(deps, path.join(src, entry.name), path.join(dest, entry.name));
    } else {
      const content = await srcFs.read(srcRel);
      await destFs.writeAtomic(destRel, content);
    }
  }
}

/**
 * Install builtin skills to motion skills directory.
 * Source: dist/skills/ (falls back to src/skills/ during development)
 */
async function installBuiltinSkills(deps: { fsFactory: (baseDir: string) => FileSystem }, motionDir: ClawDir): Promise<void> {
  // Try dist path first, fall back to src
  let skillsSource = path.join(__dirname, '..', BUNDLED_SKILLS_DIR_NAME);
  const srcFs = deps.fsFactory(__dirname);
  try {
    await srcFs.exists(path.join('..', BUNDLED_SKILLS_DIR_NAME));
  } catch {
    skillsSource = path.join(__dirname, '..', '..', '..', '..', 'src', BUNDLED_SKILLS_DIR_NAME);
  }

  let skillNames: string[];
  try {
    const skillsFs = deps.fsFactory(skillsSource);
    const entries = await skillsFs.list('.');
    skillNames = entries.filter(e => e.isDirectory).map(e => e.name);
  } catch {
    return; // no skills directory, skip
  }

  const skillsDest = path.join(motionDir, SKILLS_DIR_DEFAULT);
  for (const name of skillNames) {
    const src = path.join(skillsSource, name);
    const dest = path.join(skillsDest, name);
    await copyDir(deps, src, dest);
  }
}

/**
 * Get Motion configuration directory
 */
function getMotionConfigDir(): string {
  return path.join(process.env.HOME || process.env.USERPROFILE || '.', '.clawforum');
}

/**
 * Ensure directory exists
 */
async function ensureDir(deps: { fsFactory: (baseDir: string) => FileSystem }, dir: string): Promise<void> {
  const fs = deps.fsFactory(dir);
  await fs.ensureDir('.');
}

/**
 * Write file (only if it does not already exist)
 */
async function writeTemplate(deps: { fsFactory: (baseDir: string) => FileSystem }, filePath: string, content: string): Promise<boolean> {
  const fs = deps.fsFactory(path.dirname(filePath));
  const relPath = path.basename(filePath);
  try {
    await fs.exists(relPath);
    return false; // file already exists
  } catch {
    await fs.writeAtomic(relPath, content);
    return true; // newly created
  }
}

/**
 * motion init - create Motion configuration directory and template files
 */
export async function initCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, silent = false, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const motionDir = makeClawDir(getNamedSubrootDir(MOTION_CLAW_ID));
  const motionConfigDir = getMotionConfigDir();
  
  console.log(`Initializing Motion at: ${motionDir}`);
  
  // Create directory structure
  await ensureDir(deps, motionDir);
  await ensureDir(deps, path.join(motionDir, path.dirname(DAEMON_LOG)));
  await ensureDir(deps, path.join(motionDir, STATUS_SUBDIR));
  await ensureDir(deps, path.join(motionConfigDir, CLAWS_DIR));
  
  // Read and write template files
  const created: string[] = [];
  const existed: string[] = [];
  const failed: string[] = [];
  
  for (const name of TEMPLATE_FILES) {
    try {
      const content = await readTemplate(deps, name);
      const filePath = path.join(motionDir, name);
      const isNew = await writeTemplate(deps, filePath, content);
      if (isNew) {
        created.push(name);
      } else {
        existed.push(name);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to read template ${name}: ${errorMsg}`);
      failed.push(name);
    }
  }
  
  if (failed.length > 0) {
    throw new CliError(`Failed to process templates: ${failed.join(', ')}`);
  }
  
  // Install builtin skills
  await installBuiltinSkills(deps, motionDir);

  // Init git for motion directory
  const { fs: motionFs, audit: motionAudit } = createDirContext(deps, motionDir);
  const motionSyncDir = path.join(motionDir, 'tasks', 'sync');
  await motionFs.ensureDir(motionSyncDir);
  const motionSnapshot = new Snapshot(motionDir, motionFs, motionAudit, SNAPSHOT_IGNORE_PATTERNS, [
    path.join(motionDir, TASKS_SYNC_EXEC_DIR),
    path.join(motionDir, TASKS_SYNC_WRITE_DIR),
  ]);
  const initResult = await motionSnapshot.init();
  if (!initResult.ok) {
    // 预期失败：audit 已写；启动继续（snapshot 是旁路）
  }

  // Output results
  audit?.write(CLI_AUDIT_EVENTS.MOTION_INIT);
  console.log('\n✓ Motion initialized successfully');
  if (!silent) {
    console.log(`\nYou can now run: clawforum motion chat`);
  }
}

/**
 * motion chat - start interactive chat session (viewport mode)
 */
export async function chatCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  const globalConfig = loadGlobalConfig(deps, CONFIG_DEFAULTS);
  const motionDir = makeClawDir(getNamedSubrootDir(MOTION_CLAW_ID));
  const { audit: systemAudit } = createDirContext(deps, motionDir);

  // Check whether Motion has been initialized
  const motionFs = deps.fsFactory(motionDir);
  try {
    await motionFs.exists('AGENTS.md');
  } catch {
    throw new CliError('Motion not initialized. Run: clawforum motion init');
  }

  await runChatViewport({
    agentDir: motionDir,
    label: MOTION_CLAW_ID,
    audit: systemAudit,
    fsFactory: deps.fsFactory,
    ensureDaemon: async () => {
      const pm = createProcessManagerForCLI(deps);
      if (!pm.isAlive(MOTION_CLAW_ID)) {
        console.log('Starting Motion daemon...');
        const daemonEntryPath = resolveDaemonEntry(deps.fsFactory(motionDir));
        const pid = await pm.spawn(MOTION_CLAW_ID, {
          command: 'node',
          args: [daemonEntryPath, MOTION_CLAW_ID],
          logFile: path.join(motionDir, DAEMON_LOG),
          env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
        });
        console.log(`✓ Started (PID: ${pid})`);
      }
      // 确保 watchdog 在运行（唯一入口、phase 1269 ML#1）
      const { ensureWatchdog } = await import('../../watchdog/ensure.js');
      await ensureWatchdog(deps.fsFactory);
    },
    showRecapStream: globalConfig.viewport?.show_recap_stream,
    showSystemMessages: globalConfig.viewport?.show_system_messages,
    showContractEvents: globalConfig.viewport?.show_contract_events,
    trimOutputNewlines: globalConfig.viewport?.trim_output_newlines,
  });
}

/**
 * motion stop - 停止 Motion 守护进程
 */
export async function stopCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
  const pm = createProcessManagerForCLI(deps);

  if (!pm.isAlive(MOTION_CLAW_ID)) {
    audit?.write(CLI_AUDIT_EVENTS.MOTION_STOP, `status=not_running`);
    console.log('Motion is not running');
    return;
  }

  console.log('Stopping Motion daemon...');
  const stopped = await pm.stop(MOTION_CLAW_ID);
  if (stopped) {
    audit?.write(CLI_AUDIT_EVENTS.MOTION_STOP, `status=success`);
    console.log('✓ Stopped Motion daemon');
  } else {
    audit?.write(CLI_AUDIT_EVENTS.MOTION_STOP, `status=failed`);
    console.log('✗ Failed to stop Motion');
    process.exitCode = 1;
  }
}
