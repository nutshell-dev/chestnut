/**
 * Motion CLI commands
 *
 * Commands:
 * - motion init: create the .chestnut/motion/ directory and write template files
 * - motion chat: start an interactive chat session
 *
 * Motion is the manager; it manages other Claws by calling the CLI via exec and has no dedicated tools.
 */

import { getWorkspaceRoot, getChestnutRoot } from '../../core/claw-topology/index.js';
import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { fileURLToPath } from 'url';
import type { RootConfigReader } from '../../assembly/index.js';
import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { STATUS_SUBDIR } from '../../foundation/process-manager/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';

import { runChatViewport } from './chat-viewport.js';
import { createViewportAudit } from './viewport-audit-events.js';
import { drainOutbox, printOutboxResults, type OutboxDrainOptions } from './claw-outbox.js';
import { CliError } from '../errors.js';
import { Snapshot } from '../../foundation/snapshot/index.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 归 Assembly 装配组装、走 assembly barrel (CLI L6 → Assembly L6 barrel)
import { SNAPSHOT_IGNORE_PATTERNS } from '../../assembly/index.js';
import { CLAW_SPEC_FILE, CLAW_SOUL_FILE, CLAW_AUTH_POLICY_FILE, CLAW_HEARTBEAT_FILE } from '../../foundation/claw-identity/index.js';
import { CLAWS_DIR } from '../../core/claw-topology/index.js';
import { createDaemonSpawnOptions, DAEMON_LOG } from '../../daemon/index.js';
import { TASKS_SYNC_EXEC_DIR } from '../../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR } from '../../foundation/file-tool/index.js';
import { SKILLS_DIR_DEFAULT, BUNDLED_SKILLS_DIR_NAME } from '../../foundation/skill-system/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { copyDir } from '../utils/copy-dir.js';

// Get current file directory (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template file names (supports both build artifacts and source directory)
const TEMPLATE_FILES = [CLAW_SPEC_FILE, CLAW_SOUL_FILE, CLAW_AUTH_POLICY_FILE, CLAW_HEARTBEAT_FILE];

/** motion outbox drain 默认读取条数。 */
export const DEFAULT_OUTBOX_DRAIN_LIMIT = 1;

export interface MotionRuntimeDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal'>;
}

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
    const srcPath = path.join(__dirname, '..', 'src', 'templates', 'motion', name);
    const srcFs = deps.fsFactory(path.dirname(srcPath));
    return srcFs.readSync(path.basename(srcPath));
  }
}

/**
 * Install builtin skills to motion skills directory.
 * Source: dist/skills/ (falls back to src/skills/ during development)
 */
async function installBuiltinSkills(deps: { fsFactory: (baseDir: string) => FileSystem }, motionDir: string): Promise<void> {
  // Try dist path first, fall back to src
  let skillsSource = path.join(__dirname, BUNDLED_SKILLS_DIR_NAME);
  const srcFs = deps.fsFactory(__dirname);
  if (!(await srcFs.exists(BUNDLED_SKILLS_DIR_NAME))) {
    skillsSource = path.join(__dirname, '..', 'src', BUNDLED_SKILLS_DIR_NAME);
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
  return path.join(process.env.HOME || process.env.USERPROFILE || '.', '.chestnut');
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
    // phase 446 (review N3-H1): 单 O_EXCL syscall 消除原 exists + writeAtomic TOCTOU；
    // 防并发 motion init 或外部修改在窗口内创建后被覆盖（SOUL.md/USER.md 用户数据保护）。
    await fs.writeExclusive(relPath, content);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * motion init - create Motion configuration directory and template files
 */
export async function initCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, silent = false, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
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
      const errorMsg = formatErr(err);
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
    console.log(`\nYou can now run: chestnut motion chat`);
  }
}

/**
 * motion chat - start interactive chat session (viewport mode)
 */
export async function chatCommand(deps: MotionRuntimeDeps): Promise<void> {
  const globalConfig = deps.rootConfig.loadGlobal();
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  // phase 1279 Step A: viewport routing 由 Chat Viewport owner 工厂兑现（四高频事件落 viewport.tsv）
  const systemAudit = createViewportAudit(deps.fsFactory(motionDir), motionDir);

  // Check whether Motion has been initialized
  const motionFs = deps.fsFactory(motionDir);
  if (!(await motionFs.exists(CLAW_SPEC_FILE))) {
    throw new CliError('Motion not initialized. Run: chestnut motion init');
  }

  await runChatViewport({
    agentDir: motionDir,
    label: MOTION_CLAW_ID,
    audit: systemAudit,
    fsFactory: deps.fsFactory,
    ensureDaemon: async () => {
      const pm = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
      if (!pm.getAliveStatus(resolveClawDaemonDir(MOTION_CLAW_ID)).alive) {
        console.log('Starting Motion daemon...');
        // Phase 1464 Step B: spawn specification 归 Daemon 唯一 owner
        const pid = await pm.spawn(resolveClawDaemonDir(MOTION_CLAW_ID), createDaemonSpawnOptions({
          clawId: MOTION_CLAW_ID,
          agentDir: motionDir,
          workspaceRoot: getWorkspaceRoot(),
        }));
        console.log(`✓ Started (PID: ${pid})`);
      }
    },
    showRecapStream: globalConfig.viewport.show_recap_stream,
    showSystemMessages: globalConfig.viewport.show_system_messages,
    showContractEvents: globalConfig.viewport.show_contract_events,
    trimOutputNewlines: globalConfig.viewport.trim_output_newlines,
    userInputInlineMaxChars: globalConfig.viewport.user_input_inline_max_chars,
  });
}

/**
 * motion outbox - drain Motion's own outbox (messages written by motion's send tool)
 */
export async function motionOutboxCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  options: OutboxDrainOptions = {},
  extraDeps?: { audit?: AuditLog },
): Promise<void> {
  const audit = extraDeps?.audit;
  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const motionFs = deps.fsFactory(motionDir);
  if (!motionFs.existsSync('.')) {
    throw new CliError(
      `Motion directory not found: ${motionDir}. ` +
      `Run \`chestnut motion init\` first.`
    );
  }

  audit?.write(CLI_AUDIT_EVENTS.MOTION_OUTBOX_DRAIN_START, `limit=${options.limit ?? DEFAULT_OUTBOX_DRAIN_LIMIT}`);
  const { drained, remaining } = await drainOutbox(
    motionFs,
    audit ?? { write: () => {} } as unknown as AuditLog,
    options,
  );
  audit?.write(CLI_AUDIT_EVENTS.MOTION_OUTBOX_DRAIN_DONE, `count=${drained.length}`, `remaining=${remaining}`);

  printOutboxResults(drained, remaining);
}

/**
 * motion stop - 停止 Motion 守护进程
 */
export async function stopCommand(deps: MotionRuntimeDeps, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  deps.rootConfig.loadGlobal();
  const pm = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });

  if (!pm.getAliveStatus(resolveClawDaemonDir(MOTION_CLAW_ID)).alive) {
    audit?.write(CLI_AUDIT_EVENTS.MOTION_STOP, `status=not_running`);
    console.log('Motion is not running');
    return;
  }

  console.log('Stopping Motion daemon...');
  const stopped = await pm.stop(resolveClawDaemonDir(MOTION_CLAW_ID));
  if (stopped) {
    audit?.write(CLI_AUDIT_EVENTS.MOTION_STOP, `status=success`);
    console.log('✓ Stopped Motion daemon');
    return;
  }
  // phase 355 C2 (review-2026-06-13): throw CliError 而非 process.exitCode=1 静默。
  // process.exitCode 等 Node 自然 drain + audit writer fs flush 才退、race 可能
  // 把 code 改回 0；throw 让 handleCliError 立即 process.exit(1)、CI 看到真信号。
  audit?.write(CLI_AUDIT_EVENTS.MOTION_STOP, `status=failed`);
  throw new CliError('✗ Failed to stop Motion', 1);
}
