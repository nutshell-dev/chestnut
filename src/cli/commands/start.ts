/**
 * start command - One-shot entry point
 *
 * Initializes workspace and Motion if needed, then opens Motion chat.
 * - First run: creates Onboarding contract for onboarding
 * - Onboarding complete: goes straight to chat
 * - Partial onboarding: resumes with a reminder
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';

import { isInitialized, loadGlobalConfig, getNamedSubrootDir, buildLLMConfig, patchGlobalConfigPrimary, FORMAT_MAP } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { createLLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { PRESETS } from '../../foundation/config/index.js';
import { initCommand } from './init.js';
import {
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
} from './motion.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/factories.js';
import { passwordQuestion } from '../utils/password-prompt.js';
import { ContractSystem } from '../../core/contract/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { createDirContext } from '../../foundation/process-manager/factories.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { makeClawforumRoot } from '../../foundation/identity/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';

import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { getWorkspaceRoot } from '../../foundation/paths.js';
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

type LLMErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'unknown';

function classifyLLMError(err: unknown): LLMErrorType {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('authentication')) return 'auth';
  if (msg.includes('404') || msg.includes('model') || msg.includes('not found')) return 'model';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) return 'rate_limit';
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') || msg.includes('timeout') || msg.includes('fetch')) return 'network';
  return 'unknown';
}

const LLM_ERROR_LABELS: Record<LLMErrorType, string> = {
  auth: 'API key invalid or unauthorized',
  model: 'Model not found or unavailable',
  network: 'Network error — could not reach provider',
  rate_limit: 'Rate limit or quota exceeded',
  unknown: 'Unknown error',
};

/**
 * Test LLM connectivity with a minimal call.
 * Returns { ok: true, model } on success, { ok: false, errorType, message } on failure.
 */
async function checkLLMConnection(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<
  { ok: true; model: string } | { ok: false; errorType: LLMErrorType; message: string }
> {
  const globalConfig = loadGlobalConfig(deps, CONFIG_DEFAULTS);
  const llmConfig = buildLLMConfig(globalConfig);
  const svc = createLLMOrchestrator({
    primary: llmConfig.primary,
    fallbacks: [],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: () => {} },  // noop: health check, no audit semantics
  });
  try {
    await svc.call({
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1,
    });
    return { ok: true, model: llmConfig.primary.model };
  } catch (err) {
    return { ok: false, errorType: classifyLLMError(err), message: err instanceof Error ? err.message : String(err) };
  }
}



/**
 * Interactive reconfigure prompt shown when LLM connection fails.
 * Returns true if user successfully reconfigured (or chose to skip), false if they exit.
 *
 * Menu: 1=API key, 2=model, 3=format+baseURL, n=exit
 * Back navigation works within each sub-flow.
 * After any change, re-tests the connection automatically.
 */
async function promptReconfigure(deps: { fsFactory: (baseDir: string) => FileSystem }, rl: readline.Interface, errorType: LLMErrorType): Promise<boolean> {
  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(`${prompt}: `, ans => resolve(ans.trim())));

  // password prompt 内联 prompt suffix（caller style 1）
  const passwordPrompt = (prompt: string) => passwordQuestion(rl, `${prompt}: `);

  // 已知 provider 列表：在函数体内计算一次，option 3 子流程复用
  const presetList = Object.values(PRESETS).filter(p => p.defaultBaseUrl);
  const customIdx = presetList.length + 1;

  console.log(`\n  Error: ${LLM_ERROR_LABELS[errorType]}`);

  while (true) {
    console.log('\nReconfigure LLM:');
    console.log('  1. Update API key');
    console.log('  2. Change model');
    console.log('  3. Change format & base URL');
    console.log('  n. Exit');
    const choice = await question('\n> ');

    if (choice === 'n' || choice === 'N') return false;

    if (choice === '1') {
      const raw = await passwordPrompt('New API key');
      if (raw === 'b') continue;
      if (!raw) { console.log('  API key is required.'); continue; }
      patchGlobalConfigPrimary(deps, { api_key: raw });

    } else if (choice === '2') {
      const raw = await question('New model (b = back, "auto" = preset default)');
      if (raw === 'b') continue;
      if (!raw) { console.log('  Model is required. Type "auto" to use preset default.'); continue; }
      patchGlobalConfigPrimary(deps, { model: raw });

    } else if (choice === '3') {
      type FmtStep = 'pick' | 'customFormat' | 'baseUrl' | 'done';
      let step: FmtStep = 'pick';
      let chosenPreset = '';
      let chosenBaseUrl = '';

      while (step !== 'done') {
        if (step === 'pick') {
          console.log('\nChange provider (b = back to menu):');
          presetList.forEach((p, i) =>
            console.log(`  ${i + 1}. ${p.displayName}  (${p.defaultBaseUrl})`)
          );
          console.log(`  ${customIdx}. Custom (enter format & base URL manually)`);

          const raw = await question('\n> ');
          if (raw === 'b') break;
          const idx = parseInt(raw, 10);
          if (isNaN(idx)) { console.log('  Invalid choice: not a number.'); continue; }

          if (idx >= 1 && idx <= presetList.length) {
            const p = presetList[idx - 1];
            chosenPreset = p.id;
            chosenBaseUrl = p.defaultBaseUrl ?? '';
            patchGlobalConfigPrimary(deps, { preset: chosenPreset, base_url: chosenBaseUrl || undefined });
            console.log(`  ✓ Set provider to ${p.displayName}`);
            step = 'done';
          } else if (idx === customIdx) {
            step = 'customFormat';
          } else {
            console.log('  Invalid choice.');
          }

        } else if (step === 'customFormat') {
          console.log('\nAPI format (b = back):');
          console.log('  1. Anthropic');
          console.log('  2. OpenAI');
          console.log('  3. Gemini');
          const raw = await question('\n> ');
          if (raw === 'b') { step = 'pick'; continue; }
          chosenPreset = FORMAT_MAP[raw] ?? '';
          if (!chosenPreset) { console.log('  Invalid choice.'); continue; }
          step = 'baseUrl';

        } else if (step === 'baseUrl') {
          const raw = await question('Base URL (b = back)');
          if (raw === 'b') { step = 'customFormat'; continue; }
          if (!raw) { console.log('  Base URL is required.'); continue; }
          chosenBaseUrl = raw;
          patchGlobalConfigPrimary(deps, { preset: chosenPreset, base_url: chosenBaseUrl });
          step = 'done';
        }
      }

      if (step !== 'done') continue; // 'b' at pick step

    } else {
      console.log('  Invalid choice.');
      continue;
    }

    // Re-test after any change
    console.log('  Testing connection...');
    const result = await checkLLMConnection(deps);
    if (result.ok) {
      console.log('  ✓ Connection successful!');
      return true;
    }
    console.log(`  ✗ ${LLM_ERROR_LABELS[result.errorType]}`);
    // loop back to menu to try again
  }
}

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
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const thisFs = deps.fsFactory(thisDir);
  const daemonEntryPath = thisFs.existsSync('daemon-entry.js') ? path.join(thisDir, 'daemon-entry.js') : path.resolve(thisDir, '..', '..', 'daemon-entry.js');
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

    const manager = new ContractSystem({ clawDir: motionDir, clawId: MOTION_CLAW_ID, fs: notifyFs, audit: notifyAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory });
    const contractId = await manager.create({
      title: 'Onboarding',
      goal: 'Get to know the user and establish your identity before anything else. No interrogation — just talk.',
      subtasks: buildOnboardingSubtasks(language),
      verification: [],
    });

    
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
      const manager = new ContractSystem({ clawDir: motionDir, clawId: MOTION_CLAW_ID, fs: notifyFs, audit: notifyAudit, toolRegistry: createToolRegistry(), fsFactory: deps.fsFactory });
      const contractId = await manager.create({
        title: 'Onboarding',
        goal: 'Get to know the user and establish your identity before anything else.',
        subtasks: buildOnboardingSubtasks('auto'),
        verification: [],
      });
      notifyClaw(notifyFs, makeClawforumRoot(path.dirname(motionDir)), MOTION_CLAW_ID, {
        type: 'message', source: 'system', priority: 'high',
        body: `New contract created (${contractId}): Onboarding. Please begin execution.`,
        idPrefix: 'start',
      }, notifyAudit);
    } else {
      const pendingList = onboarding.pending?.join(', ') ?? '';
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
