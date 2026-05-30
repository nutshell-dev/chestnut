/**
 * start command - One-shot entry point
 *
 * Initializes workspace and Motion if needed, then opens Motion chat.
 * - First run: creates Onboarding contract for onboarding
 * - Onboarding complete: goes straight to chat
 * - Partial onboarding: resumes with a reminder
 */

import * as path from 'path';
import * as readline from 'readline';

import { isInitialized, getNamedSubrootDir } from '../../foundation/config/index.js';
import { initCommand } from './init.js';
import {
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
} from './motion.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { checkLLMConnection, promptReconfigure, LLM_ERROR_LABELS } from '../llm-connection-check.js';
import { ContractSystem } from '../../core/contract/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { makeClawforumRoot } from '../../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';

import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { getWorkspaceRoot, resolveDaemonEntry } from '../../foundation/paths.js';
import { readOnboardingStatus, type OnboardingStatus } from '../../core/contract/index.js';
import { DAEMON_LOG } from '../../daemon/constants.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { type ClawDir, makeClawDir } from '../../foundation/identity/index.js';

export function buildOnboardingSubtasks(language: string): Array<{ id: string; description: string }> {
  let langInstruction: string;
  if (language === 'auto') {
    langInstruction = "Detect the user's preferred language from their first message and respond in it immediately.";
  } else {
    langInstruction = `The user typed "${language}" at the language prompt. Infer the language from this text and respond in that language immediately.`;
  }

  return [
    {
      id: 'language',
      description: `${langInstruction} Write the language preference to USER.md (not inside clawspace/).`,
    },
    {
      id: 'identity',
      description: 'You are the coordinator of Claws — "Motion" is your system role, not your name. Ask the user what they want to call you, and what kind of vibe or presence they want from you. Write the result to IDENTITY.md (not inside clawspace/).',
    },
    {
      id: 'user',
      description: 'Learn who they are: name, how to address them, any relevant context. Write to USER.md (not inside clawspace/).',
    },
    {
      id: 'soul',
      description: 'Open SOUL.md together. Talk about what matters to them and how they want you to behave. Update SOUL.md (not inside clawspace/) with what you learn.',
    },
    {
      id: 'first-claw',
      description: 'Help the user create their first Claw. Ask what task or project they want to work on. A Claw is a separate context window for a specific ongoing task — all Claws have identical capabilities, they just handle different work. Run both commands: exec: clawforum claw create <name>, then exec: clawforum claw daemon <name>',
    },
    {
      id: 'first-contract',
      description: 'Help the user assign the first contract to their new Claw. Ask what they want to get done, then create the contract via dispatch: { "task": "为 <claw-name> 创建契约：<task description>" }',
    },
    {
      id: 'ready',
      description: 'Onboarding is complete. Let them know everything is set up and the Claw is working on their first task.',
    },
  ];
}

export async function pickLanguage(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log('\nSelect language / 选择语言:');
    console.log('type any word for auto-detect (e.g. hello, 你好)\n');
    rl.question('> ', (answer) => {
      rl.close();
      const t = answer.trim();
      resolve(t || 'auto');
    });
  });
}

/**
 * Atomic snapshot of initialization + onboarding state.
 * Merges two disk reads into a single synchronous call to eliminate
 * TOCTOU window between isInitialized() and getOnboardingStatus().
 */
export function getInitializationSnapshot(deps: { fsFactory: (baseDir: string) => FileSystem }, motionDir: ClawDir): {
  isInitialized: boolean;
  onboarding: OnboardingStatus;
} {
  return {
    isInitialized: isInitialized(deps),
    onboarding: getOnboardingStatus(motionDir, deps),
  };
}

/**
 * Find the Onboarding contract and determine its completion state.
 * Wrapper around L4 readOnboardingStatus pure helper (static-phase path).
 */
export function getOnboardingStatus(motionDir: ClawDir, deps: { fsFactory: (baseDir: string) => FileSystem }): OnboardingStatus {
  return readOnboardingStatus(motionDir, deps);
}

/* LLM connection check & reconfigure helpers moved to ../llm-connection-check.ts (phase 1470). */

export async function startCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  try {
    await _start(deps, audit);
  } catch (error) {
    throw new CliError('clawforum start failed: ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function _start(deps: { fsFactory: (baseDir: string) => FileSystem }, audit?: AuditLog): Promise<void> {
  // Step 1: workspace init
  const motionDir = makeClawDir(getNamedSubrootDir(MOTION_CLAW_ID));
  const snapshot = getInitializationSnapshot(deps, motionDir);
  const wasFirstRun = !snapshot.isInitialized;
  if (wasFirstRun) {
    await initCommand(deps, true);
  }
  // Step 1b: test LLM connection; offer inline reconfigure for actionable errors
  {
    console.log('Testing LLM connection...');
    const connResult = await checkLLMConnection(deps);
    if (!connResult.ok) {
      if (connResult.errorType === 'auth' || connResult.errorType === 'model') {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const fixed = await promptReconfigure(deps, rl, connResult.errorType);
          if (!fixed) {
            throw new CliError('LLM not configured. Run "clawforum init" or fix your config.');
          }
        } finally {
          rl.close();
        }
      } else {
        // network / rate_limit / unknown — warn but continue (transient)
        console.warn(`  ⚠ ${LLM_ERROR_LABELS[connResult.errorType]} — continuing anyway`);
      }
    } else {
      console.log(`  ✓ ${connResult.model}`);
    }
  }

  // Step 2: motion init
  const { fs: notifyFs, audit: notifyAudit } = createDirContext(deps, motionDir);
  const daemonEntryPath = resolveDaemonEntry(notifyFs);
  const motionSpawnOptions = {
    command: 'node' as const,
    args: [daemonEntryPath, MOTION_CLAW_ID],
    logFile: path.join(motionDir, DAEMON_LOG),
    env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
  };
  const motionFs = deps.fsFactory(motionDir);
  if (!motionFs.existsSync('AGENTS.md')) {
    await motionInitCommand(deps, true);
  }

  // Step 3: onboarding 状态
  const onboarding = snapshot.onboarding;

  // onboarding 已完成 → 直接进 chat
  if (onboarding.state === 'complete') {
    const pm = createProcessManagerForCLI(deps);
    if (!pm.isAlive(MOTION_CLAW_ID)) {
      await pm.spawn(MOTION_CLAW_ID, motionSpawnOptions);
    }
    const { ensureWatchdog } = await import('../../watchdog/ensure.js');
    await ensureWatchdog(deps.fsFactory);
    await motionChatCommand(deps);
    return;
  }

  if (wasFirstRun && onboarding.state === 'not_found') {
    // ★ 首次运行：后台启动 daemon，前台展示语言选择（并行）
    const pm = createProcessManagerForCLI(deps);
    const daemonReady = (async () => {
      if (!pm.isAlive(MOTION_CLAW_ID)) {
        await pm.spawn(MOTION_CLAW_ID, motionSpawnOptions);
      }
    })();
    daemonReady.catch((err: unknown) => {
      // 防止并行期间 UnhandledPromiseRejection；同时留 audit row 防 pickLanguage 异常导致 await daemonReady 永不达
      // 正常路径 line 412 `await daemonReady` 仍正确 rethrow → handleCliError 走规范路径
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      notifyAudit?.write(
        CLI_AUDIT_EVENTS.DAEMON_SPAWN_RACE_FAILED,
        `context=first_run_parallel_pickLanguage`,
        `error=${errMsg}`,
      );
    });

    const language = await pickLanguage();
    await daemonReady;
    const { ensureWatchdog } = await import('../../watchdog/ensure.js');
    await ensureWatchdog(deps.fsFactory);

    const manager = new ContractSystem({ clawDir: motionDir, clawId: MOTION_CLAW_ID, fs: notifyFs, audit: notifyAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, clawforumRoot: makeClawforumRoot(path.dirname(motionDir)) });
    const contractId = await manager.create({
      title: 'Onboarding',
      goal: 'Get to know the user and establish your identity before anything else. No interrogation — just talk.',
      subtasks: buildOnboardingSubtasks(language),
      verification: [],
    });

    
    // Motion-only callsite: motionDir = <clawforumRoot>/motion → dirname 一层即 clawforumRoot
    notifyClaw(notifyFs, makeClawforumRoot(path.dirname(motionDir)), MOTION_CLAW_ID, {
      type: 'message',
      source: 'system',
      priority: 'high',
      body: `New contract created (${contractId}): Onboarding. Please begin execution.`,
      idPrefix: 'start',
    }, notifyAudit);

  } else {
    // 非首次但 not_found（极少），或 in_progress
    const pm = createProcessManagerForCLI(deps);
    if (!pm.isAlive(MOTION_CLAW_ID)) {
      await pm.spawn(MOTION_CLAW_ID, motionSpawnOptions);
    }
    const { ensureWatchdog } = await import('../../watchdog/ensure.js');
    await ensureWatchdog(deps.fsFactory);

    
    if (onboarding.state === 'not_found') {
      const manager = new ContractSystem({ clawDir: motionDir, clawId: MOTION_CLAW_ID, fs: notifyFs, audit: notifyAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory, clawforumRoot: makeClawforumRoot(path.dirname(motionDir)) });
      const contractId = await manager.create({
        title: 'Onboarding',
        goal: 'Get to know the user and establish your identity before anything else.',
        subtasks: buildOnboardingSubtasks('auto'),
        verification: [],
      });
      // Motion-only callsite: motionDir = <clawforumRoot>/motion → dirname 一层即 clawforumRoot
      notifyClaw(notifyFs, makeClawforumRoot(path.dirname(motionDir)), MOTION_CLAW_ID, {
        type: 'message', source: 'system', priority: 'high',
        body: `New contract created (${contractId}): Onboarding. Please begin execution.`,
        idPrefix: 'start',
      }, notifyAudit);
    } else {
      const pendingList = onboarding.pending?.join(', ') ?? '';
      // Motion-only callsite: motionDir = <clawforumRoot>/motion → dirname 一层即 clawforumRoot
      notifyClaw(notifyFs, makeClawforumRoot(path.dirname(motionDir)), MOTION_CLAW_ID, {
        type: 'message', source: 'system', priority: 'high',
        body: `Resuming Onboarding contract (${onboarding.contractId}). Pending subtasks: ${pendingList}. Please continue.`,
        idPrefix: 'start',
      }, notifyAudit);
    }
  }

  audit?.write(CLI_AUDIT_EVENTS.DAEMON_START);
  // Step 5: 打开 chat
  await motionChatCommand(deps);
}
