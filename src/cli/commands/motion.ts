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
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadGlobalConfig, getNamedSubrootDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { PROCESS_SPAWN_CONFIRM_MS, STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';

import { runChatViewport } from './chat-viewport.js';
import { CliError } from '../errors.js';
import { Snapshot } from '../../foundation/snapshot/index.js';
import { createDirContext, createProcessManagerForCLI } from '../utils/factories.js';
import { SNAPSHOT_IGNORE_PATTERNS } from '../../assembly/snapshot-patterns.js';
import { CLAWS_DIR, getWorkspaceRoot } from '../../foundation/paths.js';
import { DAEMON_LOG } from '../constants.js';
import { TASKS_SYNC_EXEC_DIR } from '../../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../../foundation/file-tool/index.js';
import { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME } from '../../foundation/skill-system/skill-paths.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
// Get current file directory (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template file names (supports both build artifacts and source directory)
const TEMPLATE_FILES = ['AGENTS.md', 'SOUL.md', 'AUTH_POLICY.md', 'HEARTBEAT.md'];

/**
 * Read template file content (falls back from build artifacts to source directory)
 */
async function readTemplate(name: string): Promise<string> {
  // Try dist path first
  const distPath = path.join(__dirname, 'templates', 'motion', name);
  try {
    return await fs.readFile(distPath, 'utf-8');
  } catch {
    // Fall back to src path (during development)
    const srcPath = path.join(__dirname, '..', '..', '..', '..', 'src', 'cli', 'commands', 'templates', 'motion', name);
    return await fs.readFile(srcPath, 'utf-8');
  }
}

/**
 * Copy directory recursively
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install builtin skills to motion skills directory.
 * Source: dist/skills/ (falls back to src/skills/ during development)
 */
async function installBuiltinSkills(motionDir: string): Promise<void> {
  // Try dist path first, fall back to src
  let skillsSource = path.join(__dirname, '..', BUNDLED_SKILLS_DIR_NAME);
  try {
    await fs.access(skillsSource);
  } catch {
    skillsSource = path.join(__dirname, '..', '..', '..', '..', 'src', BUNDLED_SKILLS_DIR_NAME);
  }

  let skillNames: string[];
  try {
    const entries = await fs.readdir(skillsSource, { withFileTypes: true });
    skillNames = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return; // no skills directory, skip
  }

  const skillsDest = path.join(motionDir, SKILLS_DIR_DEFAULT);
  for (const name of skillNames) {
    const src = path.join(skillsSource, name);
    const dest = path.join(skillsDest, name);
    await copyDir(src, dest);
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
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Write file (only if it does not already exist)
 */
async function writeTemplate(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false; // file already exists
  } catch {
    await fs.writeFile(filePath, content, 'utf-8');
    return true; // newly created
  }
}

/**
 * motion init - create Motion configuration directory and template files
 */
export async function initCommand(silent = false, deps?: { audit?: AuditLog }): Promise<void> {
  const audit = deps?.audit;
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const motionConfigDir = getMotionConfigDir();
  
  console.log(`Initializing Motion at: ${motionDir}`);
  
  // Create directory structure
  await ensureDir(motionDir);
  await ensureDir(path.join(motionDir, path.dirname(DAEMON_LOG)));
  await ensureDir(path.join(motionDir, STATUS_SUBDIR));
  await ensureDir(path.join(motionConfigDir, CLAWS_DIR));
  
  // Read and write template files
  const created: string[] = [];
  const existed: string[] = [];
  const failed: string[] = [];
  
  for (const name of TEMPLATE_FILES) {
    try {
      const content = await readTemplate(name);
      const filePath = path.join(motionDir, name);
      const isNew = await writeTemplate(filePath, content);
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
  await installBuiltinSkills(motionDir);

  // Init git for motion directory
  const { fs: motionFs, audit: motionAudit } = createDirContext(motionDir);
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
export async function chatCommand(): Promise<void> {
  const globalConfig = loadGlobalConfig(CONFIG_DEFAULTS);
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const { audit: systemAudit } = createDirContext(motionDir);

  // Check whether Motion has been initialized
  try {
    await fs.access(path.join(motionDir, 'AGENTS.md'));
  } catch {
    throw new CliError('Motion not initialized. Run: clawforum motion init');
  }

  await runChatViewport({
    agentDir: motionDir,
    label: MOTION_CLAW_ID,
    audit: systemAudit,
    ensureDaemon: async () => {
      const pm = createProcessManagerForCLI();
      if (!pm.isAlive(MOTION_CLAW_ID)) {
        console.log('Starting Motion daemon...');
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const bundleEntry = path.join(thisDir, 'daemon-entry.js');
        const daemonEntryPath = existsSync(bundleEntry) ? bundleEntry : path.resolve(thisDir, '..', '..', 'daemon-entry.js');
        const pid = await pm.spawn(MOTION_CLAW_ID, {
          command: 'node',
          args: [daemonEntryPath, MOTION_CLAW_ID],
          logFile: path.join(motionDir, DAEMON_LOG),
          env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
        });
        console.log(`✓ Started (PID: ${pid})`);
        await new Promise(resolve => setTimeout(resolve, PROCESS_SPAWN_CONFIRM_MS));
      }
      // 确保 watchdog 在运行（唯一入口、phase 1269 ML#1）
      const { ensureWatchdog } = await import('../../watchdog/ensure.js');
      await ensureWatchdog();
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
export async function stopCommand(deps?: { audit?: AuditLog }): Promise<void> {
  const audit = deps?.audit;
  loadGlobalConfig(CONFIG_DEFAULTS);
  const pm = createProcessManagerForCLI();

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
