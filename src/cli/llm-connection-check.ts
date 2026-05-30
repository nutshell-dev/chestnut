/**
 * LLM connection check + interactive reconfigure helpers.
 *
 * Shared by `init` (post-config verification) and `start` (every-run health check).
 * Extracted from start.ts in phase 1470.
 */

import * as readline from 'readline';

import { loadGlobalConfig, buildLLMConfig, patchGlobalConfigPrimary, FORMAT_MAP, PRESETS } from '../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../assembly/index.js';
import { createLLMOrchestrator } from '../foundation/llm-orchestrator/index.js';
import { passwordQuestion } from './utils/password-prompt.js';
import type { FileSystem } from '../foundation/fs/types.js';

export type LLMErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'unknown';

export function classifyLLMError(err: unknown): LLMErrorType {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('authentication')) return 'auth';
  if (msg.includes('404') || msg.includes('model') || msg.includes('not found')) return 'model';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) return 'rate_limit';
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') || msg.includes('timeout') || msg.includes('fetch')) return 'network';
  return 'unknown';
}

export const LLM_ERROR_LABELS: Record<LLMErrorType, string> = {
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
export async function checkLLMConnection(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<
  { ok: true; model: string } | { ok: false; errorType: LLMErrorType; message: string }
> {
  const globalConfig = loadGlobalConfig(deps, CONFIG_DEFAULTS);
  const llmConfig = buildLLMConfig(globalConfig);
  const svc = createLLMOrchestrator({
    primary: llmConfig.primary,
    fallbacks: [],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: () => {} },
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
 * Returns true if user successfully reconfigured, false if they exit.
 *
 * Menu: 1=API key, 2=model, 3=format+baseURL, n=exit
 * After any change, re-tests the connection automatically.
 */
export async function promptReconfigure(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  rl: readline.Interface,
  errorType: LLMErrorType,
): Promise<boolean> {
  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(`${prompt}: `, ans => resolve(ans.trim())));

  const passwordPrompt = (prompt: string) => passwordQuestion(rl, `${prompt}: `);

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

      if (step !== 'done') continue;

    } else {
      console.log('  Invalid choice.');
      continue;
    }

    console.log('  Testing connection...');
    const result = await checkLLMConnection(deps);
    if (result.ok) {
      console.log('  ✓ Connection successful!');
      return true;
    }
    console.log(`  ✗ ${LLM_ERROR_LABELS[result.errorType]}`);
  }
}
