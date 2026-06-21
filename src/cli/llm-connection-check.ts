/**
 * LLM connection check + interactive reconfigure helpers.
 *
 * Shared by `init` (post-config verification) and `start` (every-run health check).
 * Extracted from start.ts in phase 1470.
 */

import * as readline from 'readline';
import { formatErr } from "../foundation/utils/index.js";

import { loadGlobalConfig, patchGlobalConfigPrimary } from '../assembly/config-load.js';
import { PRESETS } from '../foundation/config/index.js';
import { FORMAT_MAP } from '../foundation/llm-orchestrator/index.js';
import { buildLLMConfig } from '../assembly/config-load.js';
import { createLLMOrchestrator } from '../foundation/llm-orchestrator/index.js';
import { passwordQuestion } from './utils/password-prompt.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { ProviderConfig } from '../foundation/llm-provider/index.js';

export type LLMErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'quota' | 'unknown';

export function classifyLLMError(err: unknown): LLMErrorType {
  const msg = (formatErr(err)).toLowerCase();

  // quota 优先于 rate_limit / auth（permanent、需用户介入）
  if (msg.includes('quota') || msg.includes('insufficient') || msg.includes('credit') || msg.includes('billing')) {
    return 'quota';
  }

  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('api key') || msg.includes('authenticat')) return 'auth';
  if (msg.includes('404') || msg.includes('not found') || (msg.includes('model') && !msg.includes('network'))) return 'model';
  if (msg.includes('429') || msg.includes('rate limit')) return 'rate_limit';
  // network：含 5xx 服务器错（短暂性、重试可救）
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') ||
      msg.includes('timeout') || msg.includes('fetch') ||
      /5\d\d/.test(msg) || msg.includes('server error') || msg.includes('bad gateway') || msg.includes('service unavailable')) {
    return 'network';
  }
  return 'unknown';
}

export const LLM_ERROR_LABELS: Record<LLMErrorType, string> = {
  auth: 'API key invalid or unauthorized',
  model: 'Model not found or unavailable',
  network: 'Network error — could not reach provider',
  rate_limit: 'Rate limit exceeded',
  quota: 'Account quota or credit exhausted',
  unknown: 'Unrecognized provider error',
};

export const LLM_ERROR_HINTS: Partial<Record<LLMErrorType, string>> = {
  auth: 'Update API key via "chestnut config provider add".',
  model: 'Check that model name matches provider docs exactly.',
  network: 'Check internet connection or provider status page.',
  rate_limit: 'Wait a few seconds and retry; lower request frequency.',
  quota: 'Top up account credit or switch provider via "chestnut config".',
  unknown: 'See raw provider message above; report bug if persistent.',
};

const LLM_ERROR_PREVIEW_CHARS = 200;

/**
 * Format a failed LLM probe result as console output lines (callers do console.log(...lines)).
 * Single source of truth for LLM error display across init / config / reconfigure.
 */
export function formatLLMError(
  probe: { errorType: LLMErrorType; message: string; provider?: string; hint?: string },
): string[] {
  const lines: string[] = [];
  lines.push(`✗ ${LLM_ERROR_LABELS[probe.errorType]}`);
  if (probe.provider) {
    lines.push(`  Provider: ${probe.provider}`);
  }
  // phase 464 (review N3-L): 按 codepoint 截断，避免 UTF-16 surrogate pair 被切断
  const codepoints = [...probe.message];
  const trimmed = codepoints.length > LLM_ERROR_PREVIEW_CHARS
    ? codepoints.slice(0, LLM_ERROR_PREVIEW_CHARS).join('') + '...'
    : probe.message;
  lines.push(`  ${trimmed}`);
  if (probe.hint) {
    lines.push(`  Hint: ${probe.hint}`);
  }
  return lines;
}

/**
 * Test LLM connectivity with a minimal call.
 * Returns { ok: true, model } on success, { ok: false, errorType, message } on failure.
 */
export async function checkLLMConnection(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<
  { ok: true; model: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string }
> {
  const globalConfig = loadGlobalConfig(deps);
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
    return { ok: false, errorType: classifyLLMError(err), message: formatErr(err), provider: llmConfig.primary.name };
  }
}

/**
 * Probe an explicit provider config (not the active global primary).
 * Used by `config provider add/set-primary` to verify a candidate before commit.
 */
export async function checkLLMConnectionFor(provider: ProviderConfig): Promise<
  { ok: true; model: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string }
> {
  const svc = createLLMOrchestrator({
    primary: provider,
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
    return { ok: true, model: provider.model };
  } catch (err) {
    return { ok: false, errorType: classifyLLMError(err), message: formatErr(err), provider: provider.name };
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
  _errorType: LLMErrorType,
): Promise<boolean> {
  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(`${prompt}: `, ans => resolve(ans.trim())));

  const passwordPrompt = (prompt: string) => passwordQuestion(rl, `${prompt}: `);

  const presetList = Object.values(PRESETS).filter(p => p.defaultBaseUrl);
  const customIdx = presetList.length + 1;

  while (true) {
    console.log('\nReconfigure LLM:');
    console.log('1. Update API key');
    console.log('2. Change model');
    console.log('3. Change format & base URL');
    console.log('n. Exit');
    const choice = await question('\n> ');

    if (choice === 'n' || choice === 'N') return false;

    if (choice === '1') {
      const raw = await passwordPrompt('New API key');
      if (raw === 'b') continue;
      if (!raw) { console.log('API key is required.'); continue; }
      patchGlobalConfigPrimary(deps, { api_key: raw });

    } else if (choice === '2') {
      const raw = await question('New model (b = back, "auto" = preset default)');
      if (raw === 'b') continue;
      if (!raw) { console.log('Model is required. Type "auto" to use preset default.'); continue; }
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
            console.log(`${i + 1}. ${p.displayName}  (${p.defaultBaseUrl})`)
          );
          console.log(`${customIdx}. Custom (enter format & base URL manually)`);

          const raw = await question('\n> ');
          if (raw === 'b') break;
          const idx = parseInt(raw, 10);
          if (isNaN(idx)) { console.log('Invalid choice: not a number.'); continue; }

          if (idx >= 1 && idx <= presetList.length) {
            const p = presetList[idx - 1];
            chosenPreset = p.id;
            chosenBaseUrl = p.defaultBaseUrl ?? '';
            patchGlobalConfigPrimary(deps, { preset: chosenPreset, base_url: chosenBaseUrl || undefined });
            console.log(`✓ Set provider to ${p.displayName}`);
            step = 'done';
          } else if (idx === customIdx) {
            step = 'customFormat';
          } else {
            console.log('Invalid choice.');
          }

        } else if (step === 'customFormat') {
          console.log('\nAPI format (b = back):');
          console.log('1. Anthropic');
          console.log('2. OpenAI');
          console.log('3. Gemini');
          const raw = await question('\n> ');
          if (raw === 'b') { step = 'pick'; continue; }
          chosenPreset = FORMAT_MAP[raw] ?? '';
          if (!chosenPreset) { console.log('Invalid choice.'); continue; }
          step = 'baseUrl';

        } else if (step === 'baseUrl') {
          const raw = await question('Base URL (b = back)');
          if (raw === 'b') { step = 'customFormat'; continue; }
          if (!raw) { console.log('Base URL is required.'); continue; }
          chosenBaseUrl = raw;
          patchGlobalConfigPrimary(deps, { preset: chosenPreset, base_url: chosenBaseUrl });
          step = 'done';
        }
      }

      if (step !== 'done') continue;

    } else {
      console.log('Invalid choice.');
      continue;
    }

    console.log('Testing connection...');
    const result = await checkLLMConnection(deps);
    if (result.ok) {
      console.log('✓ Connection successful!');
      return true;
    }
    formatLLMError({
      errorType: result.errorType,
      message: result.message,
      provider: undefined,
      hint: LLM_ERROR_HINTS[result.errorType],
    }).forEach(line => console.log(line));
  }
}
