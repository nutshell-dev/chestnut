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
import { fileURLToPath } from 'url';
import { loadGlobalConfig, getMotionDir, getGlobalConfigPath } from '../config.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { ProcessManager } from '../../foundation/process-manager/index.js';
import { PROCESS_SPAWN_CONFIRM_MS } from '../../constants.js';

import { runChatViewport } from './chat-viewport.js';
import { CliError } from '../errors.js';
import { initAgentGit } from '../../foundation/git/agent-git.js';

/**
 * Create a ProcessManager dedicated to Motion
 */
export function createMotionPM(): ProcessManager {
  const baseDir = path.dirname(getMotionDir()); // .clawforum
  const nodeFs = new NodeFileSystem({ baseDir, enforcePermissions: false });
  return new ProcessManager(nodeFs, baseDir, (id) => {
    if (id === 'motion') return path.join(baseDir, 'motion');
    return path.join(baseDir, 'claws', id);
  });
}

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
  let skillsSource = path.join(__dirname, '..', 'skills');
  try {
    await fs.access(skillsSource);
  } catch {
    skillsSource = path.join(__dirname, '..', '..', '..', '..', 'src', 'skills');
  }

  let skillNames: string[];
  try {
    const entries = await fs.readdir(skillsSource, { withFileTypes: true });
    skillNames = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return; // no skills directory, skip
  }

  const skillsDest = path.join(motionDir, 'skills');
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
export async function initCommand(silent = false): Promise<void> {
  const motionDir = getMotionDir();
  const motionConfigDir = getMotionConfigDir();
  
  console.log(`Initializing Motion at: ${motionDir}`);
  
  // Create directory structure
  await ensureDir(motionDir);
  await ensureDir(path.join(motionDir, 'logs'));
  await ensureDir(path.join(motionDir, 'status'));
  await ensureDir(path.join(motionConfigDir, 'claws'));
  
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
  await initAgentGit(motionDir).catch(err =>
    console.warn('[git] motion git init failed:', err instanceof Error ? err.message : String(err))
  );

  // Output results
  console.log('\n✓ Motion initialized successfully');
  if (!silent) {
    console.log(`\nYou can now run: clawforum motion chat`);
  }
}

/**
 * motion chat - start interactive chat session (viewport mode)
 */
export async function chatCommand(): Promise<void> {
  const globalConfig = loadGlobalConfig();
  const motionDir = getMotionDir();

  // Check whether Motion has been initialized
  try {
    await fs.access(path.join(motionDir, 'AGENTS.md'));
  } catch {
    throw new CliError('Motion not initialized. Run: clawforum motion init');
  }

  await runChatViewport({
    agentDir: motionDir,
    label: 'motion',
    ensureDaemon: async () => {
      const pm = createMotionPM();
      if (!pm.isAlive('motion')) {
        console.log('Starting Motion daemon...');
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const daemonEntryPath = path.resolve(thisDir, '..', '..', 'daemon-entry.js');
        const pid = await pm.spawn('motion', {
          command: 'node',
          args: [daemonEntryPath, 'motion'],
          logFile: path.join(motionDir, 'logs', 'daemon.log'),
          env: { ...process.env, CLAWFORUM_ROOT: process.env.CLAWFORUM_ROOT ?? process.cwd() } as Record<string, string | undefined>,
        });
        console.log(`Started (PID: ${pid})`);
        await new Promise(resolve => setTimeout(resolve, PROCESS_SPAWN_CONFIRM_MS));
      }
      // 确保 watchdog 在运行（idempotent）
      const { startCommand: startWatchdog } = await import('./watchdog.js');
      await startWatchdog();
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
export async function stopCommand(): Promise<void> {
  loadGlobalConfig();
  const pm = createMotionPM();

  if (!pm.isAlive('motion')) {
    console.log('Motion is not running');
    return;
  }

  console.log('Stopping Motion daemon...');
  const stopped = await pm.stop('motion');
  console.log(stopped ? 'Stopped Motion daemon' : 'Failed to stop Motion');
}
