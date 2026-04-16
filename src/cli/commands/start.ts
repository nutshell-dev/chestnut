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
import * as fs from 'fs';
import * as readline from 'readline';
import { isInitialized, loadGlobalConfig, getMotionDir, buildLLMConfig, patchGlobalConfigPrimary, FORMAT_MAP } from '../config.js';
import { LLMService } from '../../foundation/llm/service.js';
import { PRESETS } from '../../foundation/llm/presets.js';
import { initCommand } from './init.js';
import {
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
  createMotionPM,
} from './motion.js';
import { ContractManager } from '../../core/contract/manager.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { writeInboxMessage } from '../../utils/inbox-writer.js';
import { PROCESS_SPAWN_CONFIRM_MS, MOTION_CLAW_ID } from '../../constants.js';
import { CliError } from '../errors.js';
import { startCommand as watchdogStartCommand, isWatchdogAlive } from './watchdog.js';

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

type OnboardingStatus =
  | { state: 'complete' }
  | { state: 'in_progress'; contractId: string; pending: string[] }
  | { state: 'not_found' };

/**
 * Find the Onboarding contract and determine its completion state.
 */
export function getOnboardingStatus(motionDir: string): OnboardingStatus {
  const dirs = ['contract/active', 'contract/paused', 'contract/archive'];

  for (const dir of dirs) {
    const contractsDir = path.join(motionDir, dir);
    if (!fs.existsSync(contractsDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(contractsDir);
    } catch {
      continue;
    }

    for (const contractId of entries) {
      const contractYaml = path.join(contractsDir, contractId, 'contract.yaml');
      const progressJson = path.join(contractsDir, contractId, 'progress.json');
      if (!fs.existsSync(contractYaml) || !fs.existsSync(progressJson)) continue;

      let title = '';
      try {
        const yaml = fs.readFileSync(contractYaml, 'utf-8');
        const m = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        title = m?.[1] ?? '';
      } catch { continue; }

      if (title !== 'Onboarding') continue;

      let progress: Record<string, unknown>;
      try {
        progress = JSON.parse(fs.readFileSync(progressJson, 'utf-8'));
      } catch { continue; }

      const subtasks = (progress.subtasks ?? {}) as Record<string, { status: string }>;
      const pending = Object.entries(subtasks)
        .filter(([, v]) => v.status !== 'completed')
        .map(([k]) => k);

      if (dir === 'contract/archive' && pending.length === 0) {
        return { state: 'complete' };
      }
      return { state: 'in_progress', contractId, pending };
    }
  }

  return { state: 'not_found' };
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
async function checkLLMConnection(): Promise<
  { ok: true; model: string } | { ok: false; errorType: LLMErrorType; message: string }
> {
  const globalConfig = loadGlobalConfig();
  const llmConfig = buildLLMConfig(globalConfig);
  const svc = new LLMService({ primary: llmConfig.primary, fallbacks: [], maxAttempts: 1, retryDelayMs: 0 });
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
async function promptReconfigure(rl: readline.Interface, errorType: LLMErrorType): Promise<boolean> {
  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(`${prompt}: `, ans => resolve(ans.trim())));

  const passwordQuestion = (prompt: string): Promise<string> =>
    new Promise(resolve => {
      let muted = false;
      const original = (rl as any)._writeToOutput?.bind(rl);
      (rl as any)._writeToOutput = (str: string) => { if (!muted) original?.(str); };
      rl.question(`${prompt}: `, ans => {
        muted = false;
        (rl as any)._writeToOutput = original;
        process.stdout.write('\n');
        resolve(ans.trim());
      });
      muted = true;
    });

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
      const raw = await passwordQuestion('New API key');
      if (raw === 'b') continue;
      if (!raw) { console.log('  API key is required.'); continue; }
      patchGlobalConfigPrimary({ api_key: raw });

    } else if (choice === '2') {
      const raw = await question('New model (b = back, "auto" = preset default)');
      if (raw === 'b') continue;
      if (!raw) { console.log('  Model is required. Type "auto" to use preset default.'); continue; }
      patchGlobalConfigPrimary({ model: raw });

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

          if (idx >= 1 && idx <= presetList.length) {
            const p = presetList[idx - 1];
            chosenPreset = p.id;
            chosenBaseUrl = p.defaultBaseUrl ?? '';
            patchGlobalConfigPrimary({ preset: chosenPreset, base_url: chosenBaseUrl || undefined });
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
          patchGlobalConfigPrimary({ preset: chosenPreset, base_url: chosenBaseUrl });
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
    const result = await checkLLMConnection();
    if (result.ok) {
      console.log('  ✓ Connection successful!');
      return true;
    }
    console.log(`  ✗ ${LLM_ERROR_LABELS[result.errorType]}`);
    // loop back to menu to try again
  }
}

export async function startCommand(): Promise<void> {
  try {
    await _start();
  } catch (error) {
    throw new CliError('clawforum start failed: ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function _start(): Promise<void> {
  // Step 1: workspace init
  const wasFirstRun = !isInitialized();
  if (wasFirstRun) {
    await initCommand(true);
  }
  // Step 1b: test LLM connection; offer inline reconfigure for actionable errors
  {
    console.log('Testing LLM connection...');
    const connResult = await checkLLMConnection();
    if (!connResult.ok) {
      if (connResult.errorType === 'auth' || connResult.errorType === 'model') {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const fixed = await promptReconfigure(rl, connResult.errorType);
          if (!fixed) {
            throw new Error('LLM not configured. Run "clawforum init" or fix your config.');
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
  const motionDir = getMotionDir();
  const notifyFs = new NodeFileSystem({ baseDir: motionDir, enforcePermissions: false });
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const bundleEntry = path.join(thisDir, 'daemon-entry.js');
  const daemonEntryPath = fs.existsSync(bundleEntry) ? bundleEntry : path.resolve(thisDir, '..', '..', 'daemon-entry.js');
  const motionSpawnOptions = {
    command: 'node' as const,
    args: [daemonEntryPath, 'motion'],
    logFile: path.join(motionDir, 'logs', 'daemon.log'),
    env: { ...process.env, CLAWFORUM_ROOT: process.env.CLAWFORUM_ROOT ?? process.cwd() } as Record<string, string | undefined>,
  };
  if (!fs.existsSync(path.join(motionDir, 'AGENTS.md'))) {
    await motionInitCommand(true);
  }

  // Step 3: onboarding 状态
  const onboarding = getOnboardingStatus(motionDir);

  // onboarding 已完成 → 直接进 chat
  if (onboarding.state === 'complete') {
    const pm = createMotionPM();
    if (!pm.isAlive('motion')) {
      await pm.spawn('motion', motionSpawnOptions);
      await new Promise(r => setTimeout(r, PROCESS_SPAWN_CONFIRM_MS));
    }
    if (!isWatchdogAlive()) await watchdogStartCommand();
    await motionChatCommand();
    return;
  }

  const inboxDir = path.join(motionDir, 'inbox', 'pending');

  if (wasFirstRun && onboarding.state === 'not_found') {
    // ★ 首次运行：后台启动 daemon，前台展示语言选择（并行）
    const pm = createMotionPM();
    const daemonReady = (async () => {
      if (!pm.isAlive('motion')) {
        await pm.spawn('motion', motionSpawnOptions);
        await new Promise(r => setTimeout(r, PROCESS_SPAWN_CONFIRM_MS));
      }
    })();
    daemonReady.catch(() => {}); // 防止并行期间 UnhandledPromiseRejection；await 时仍正确 rethrow

    const language = await pickLanguage();
    await daemonReady;
    if (!isWatchdogAlive()) await watchdogStartCommand();

    const motionFs = new NodeFileSystem({ baseDir: motionDir, enforcePermissions: false });
    const manager = new ContractManager(motionDir, MOTION_CLAW_ID, motionFs);
    const contractId = await manager.create({
      title: 'Onboarding',
      goal: 'Get to know the user and establish your identity before anything else. No interrogation — just talk.',
      subtasks: buildOnboardingSubtasks(language),
      acceptance: [],
    });

    writeInboxMessage(notifyFs, {
      inboxDir,
      type: 'message',
      source: 'system',
      priority: 'high',
      body: `New contract created (${contractId}): Onboarding. Please begin execution.`,
      idPrefix: 'start',
      filenameTag: 'start',
    });

  } else {
    // 非首次但 not_found（极少），或 in_progress
    const pm = createMotionPM();
    if (!pm.isAlive('motion')) {
      await pm.spawn('motion', motionSpawnOptions);
      await new Promise(r => setTimeout(r, PROCESS_SPAWN_CONFIRM_MS));
    }
    if (!isWatchdogAlive()) await watchdogStartCommand();

    if (onboarding.state === 'not_found') {
      const motionFs = new NodeFileSystem({ baseDir: motionDir, enforcePermissions: false });
      const manager = new ContractManager(motionDir, MOTION_CLAW_ID, motionFs);
      const contractId = await manager.create({
        title: 'Onboarding',
        goal: 'Get to know the user and establish your identity before anything else.',
        subtasks: buildOnboardingSubtasks('auto'),
        acceptance: [],
      });
      writeInboxMessage(notifyFs, {
        inboxDir,
        type: 'message', source: 'system', priority: 'high',
        body: `New contract created (${contractId}): Onboarding. Please begin execution.`,
        idPrefix: 'start', filenameTag: 'start',
      });
    } else {
      const pendingList = onboarding.pending.join(', ');
      writeInboxMessage(notifyFs, {
        inboxDir,
        type: 'message', source: 'system', priority: 'high',
        body: `Resuming Onboarding contract (${onboarding.contractId}). Pending subtasks: ${pendingList}. Please continue.`,
        idPrefix: 'start', filenameTag: 'start',
      });
    }
  }

  // Step 5: 打开 chat
  await motionChatCommand();
}
