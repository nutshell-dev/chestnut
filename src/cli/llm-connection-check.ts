/**
 * LLM connection check + interactive reconfigure helpers.
 *
 * Shared by `init` (post-config verification) and `start` (every-run health check).
 * Extracted from start.ts in phase 1470.
 */

import * as readline from 'readline';
import { formatErr } from "../foundation/node-utils/index.js";

import { snapshotLLMConfig, type RootConfigAdmin } from '../assembly/index.js';
import type { LLMConfigSnapshot } from '../assembly/index.js';
import { PRESETS } from '../foundation/llm-provider/index.js';
// Phase 1927 Step D：reconfigure 的 provider 选择含 catalog-only provider
import { catalogProvidersWithoutPreset } from '../foundation/llm-provider/index.js';
import { FORMAT_MAP } from '../foundation/llm-orchestrator/index.js';
import { createLLMOrchestrator } from '../foundation/llm-orchestrator/index.js';
import { passwordQuestion } from './utils/password-prompt.js';
import type { ProviderConfig } from '../foundation/llm-provider/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
// Phase 1925 Step B：reconfigure 的明文 key 经 Credentials owner 落凭据文件、配置写 `${REF}`。
import { storeKeyAsCredential } from './credentials-prompt.js';

export type LLMErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'quota' | 'unknown';

/**
 * Phase 1926 Step C：已通过 probe 的配置事实（init ↔ start 门控交接契约）。
 * 取代 Phase 1925 的无主 boolean `probeVerified`——复用条件只有一条：
 * `verified.snapshot.identity` 与消费时当前快照身份相等。
 */
export interface VerifiedLLMConfig {
  snapshot: LLMConfigSnapshot;
  probe: { model: string };
  via: 'init' | 'start';
}

interface LLMConfigDeps {
  fsFactory: (baseDir: string) => FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'loadGlobal' | 'patchPrimary'>;
}

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
  // Phase 1926 Step D：auth 类含 ambient 缺失（AWS 链/ADC/env）与 OAuth 未登录/refresh 失败
  auth: 'Update API key via "chestnut config provider add", run "chestnut config provider login <label>" for OAuth providers, or fix ambient credentials (AWS profile / Google ADC / provider env).',
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
 * Phase 1926 Step C：对**给定快照**做真实 probe——probe 内不得再隐式读取另一份
 * 配置；返回结果携带被测 identity，调用方据此丢弃漂移结果。
 */
export async function probeLLMConnection(snapshot: LLMConfigSnapshot): Promise<
  { ok: true; model: string; identity: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string; identity: string }
> {
  const svc = createLLMOrchestrator({
    ...snapshot.config,
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: () => {} },
  });
  try {
    await svc.call({
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1,
    });
    return { ok: true, model: snapshot.config.primary.model, identity: snapshot.identity };
  } catch (err) {
    return { ok: false, errorType: classifyLLMError(err), message: formatErr(err), provider: snapshot.config.primary.name, identity: snapshot.identity };
  }
}

/**
 * Test LLM connectivity with a minimal call.
 * Returns { ok: true, model } on success, { ok: false, errorType, message } on failure.
 * Phase 1926 Step C：读取即快照后委托 probeLLMConnection（读取与 probe 同一份
 * resolved object）；需要身份协议的调用方（init/start 门控）应自行 snapshot 后
 * 直接调 probeLLMConnection。
 */
export async function checkLLMConnection(deps: LLMConfigDeps): Promise<
  { ok: true; model: string; identity: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string; identity: string }
> {
  return probeLLMConnection(snapshotLLMConfig(deps.rootConfig.loadGlobal()));
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
 * Phase 1926 Step C：成功时返回**已 probe 的配置快照**（身份证据；probe 与快照
 * 同一 resolved object），用户退出返回 null。调用方复用前必须比对当前身份。
 *
 * Menu: 1=API key, 2=model, 3=format+baseURL, n=exit
 * After any change, re-tests the connection automatically.
 */
export async function promptReconfigure(
  deps: LLMConfigDeps,
  rl: readline.Interface,
  _errorType: LLMErrorType,
): Promise<LLMConfigSnapshot | null> {
  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(`${prompt}: `, ans => resolve(ans.trim())));

  const passwordPrompt = (prompt: string) => passwordQuestion(rl, `${prompt}: `);

  // Phase 1926 Step D：catalog preset（含 ambient/oauth，无 defaultBaseUrl）同样可选；
  // 仅 custom-*（无默认 baseUrl 且无 catalog 权威）留在 "Custom" 手工路径。
  const presetList = Object.values(PRESETS).filter(p => p.defaultBaseUrl || p.piAiProvider);

  while (true) {
    console.log('\nReconfigure LLM:');
    console.log('1. Update API key');
    console.log('2. Change model');
    console.log('3. Change format & base URL');
    console.log('n. Exit');
    const choice = await question('\n> ');

    if (choice === 'n' || choice === 'N') return null;

    if (choice === '1') {
      const raw = await passwordPrompt('New API key');
      if (raw === 'b') continue;
      if (!raw) { console.log('API key is required.'); continue; }
      // Phase 1925 Step B：ref 优先取当前 primary preset 的 envVar 约定名
      const currentPrimary = deps.rootConfig.loadGlobal().llm.primary;
      const currentPreset = currentPrimary.preset ? PRESETS[currentPrimary.preset] : undefined;
      const stored = await storeKeyAsCredential(deps, raw, {
        envVar: currentPreset?.envVar,
        seed: currentPrimary.label ?? currentPrimary.preset,
      });
      await deps.rootConfig.patchPrimary({ api_key: stored });

    } else if (choice === '2') {
      const raw = await question('New model (b = back, "auto" = preset default)');
      if (raw === 'b') continue;
      if (!raw) { console.log('Model is required. Type "auto" to use preset default.'); continue; }
      await deps.rootConfig.patchPrimary({ model: raw });

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
          // Phase 1927 Step D：无 preset 别名的 catalog provider 同样可选（无默认
          // model——选择后必须显式输入 model，否则旧 model 跨 provider 无意义）
          const catalogOnly = catalogProvidersWithoutPreset();
          catalogOnly.forEach((id, i) =>
            console.log(`${presetList.length + i + 1}. ${id}  (pi-ai catalog)`)
          );
          const catalogStart = presetList.length + 1;
          const customIdx = presetList.length + catalogOnly.length + 1;
          console.log(`${customIdx}. Custom (enter format & base URL manually)`);

          const raw = await question('\n> ');
          if (raw === 'b') break;
          const idx = parseInt(raw, 10);
          if (isNaN(idx)) { console.log('Invalid choice: not a number.'); continue; }

          if (idx >= 1 && idx <= presetList.length) {
            const p = presetList[idx - 1];
            chosenPreset = p.id;
            chosenBaseUrl = p.defaultBaseUrl ?? '';
            // provider 换边清除互斥的 provider_id（patch 语义：undefined = 删键）
            await deps.rootConfig.patchPrimary({ preset: chosenPreset, provider_id: undefined, base_url: chosenBaseUrl || undefined });
            console.log(`✓ Set provider to ${p.displayName}`);
            step = 'done';
          } else if (idx >= catalogStart && idx < customIdx) {
            const providerId = catalogOnly[idx - catalogStart];
            const modelRaw = await question(`Model (required for ${providerId})`);
            if (!modelRaw || modelRaw === 'b') { console.log('Model is required.'); continue; }
            await deps.rootConfig.patchPrimary({ provider_id: providerId, preset: undefined, model: modelRaw, base_url: undefined });
            console.log(`✓ Set provider to ${providerId} (catalog), model ${modelRaw}`);
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
          await deps.rootConfig.patchPrimary({ preset: chosenPreset, provider_id: undefined, base_url: chosenBaseUrl });
          step = 'done';
        }
      }

      if (step !== 'done') continue;

    } else {
      console.log('Invalid choice.');
      continue;
    }

    console.log('Testing connection...');
    const snapshot = snapshotLLMConfig(deps.rootConfig.loadGlobal());
    const result = await probeLLMConnection(snapshot);
    if (result.ok) {
      console.log('✓ Connection successful!');
      return snapshot;
    }
    formatLLMError({
      errorType: result.errorType,
      message: result.message,
      provider: undefined,
      hint: LLM_ERROR_HINTS[result.errorType],
    }).forEach(line => console.log(line));
  }
}
