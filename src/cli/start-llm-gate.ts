/**
 * Phase 1925 Step E：start LLM 验证门控 + 非交互配置输入。
 *
 * 铁律（计划 §设计细节）：
 * - start 只有在**当前有效配置**的真实 LLM 调用成功后才进入 supervision /
 *   motion / onboarding / chat；`.initialized` 只表示布局 ready，不是 probe 证据。
 * - probe 失败：交互模式留在向导内 retry/edit/cancel；非交互（--non-interactive
 *   或非 TTY）不进 readline，缺参/失败返回明确非零退出码。
 * - probe 与随后 chat 消费同一可证明快照：probe 时记 primary 指纹，
 *   门控收尾复验，漂移则重验一次，仍漂移 fail-closed。
 * - 任何 key 不进入 audit / stdout 错误预览（错误文本经 formatLLMError 截断）。
 *
 * 退出码约定：2 = 用法/缺参错误；3 = LLM 验证失败或用户取消（fail-closed）。
 */

import * as readline from 'readline';
import { PRESETS } from '../foundation/llm-provider/index.js';
import type { RootConfigAdmin } from '../assembly/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { CliError } from './errors.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import { buildInitialConfig } from './commands/init.js';
import { storeKeyAsCredential } from './credentials-prompt.js';
import {
  checkLLMConnection,
  promptReconfigure,
  formatLLMError,
  LLM_ERROR_HINTS,
} from './llm-connection-check.js';

/** start 的非交互配置参数（catalog 投影，与 commander camelCase 对应）。 */
export interface StartLLMOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 引用环境变量名（配置写 ${VAR}，不落明文）。 */
  apiKeyEnv?: string;
  language?: string;
  nonInteractive?: boolean;
}

/** 明文 key 注入环境变量（非交互；经 Credentials owner 落凭据文件写引用）。 */
export const START_LLM_API_KEY_ENV = 'CHESTNUT_LLM_API_KEY';

/** 用法/缺参错误退出码。 */
export const START_USAGE_EXIT_CODE = 2;
/** LLM 验证失败 / 用户取消退出码。 */
export const START_GATE_EXIT_CODE = 3;

interface GateDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<
    RootConfigAdmin,
    'loadGlobal' | 'saveGlobalExclusive' | 'patchPrimary' | 'completeInitialization'
  >;
}

/** 给了配置参数但缺 --non-interactive → 用法错误（不猜意图、不静默忽略参数）。 */
export function validateStartLLMOptions(opts: StartLLMOptions): void {
  const configParams = [opts.provider, opts.model, opts.baseUrl, opts.apiKeyEnv].filter(Boolean);
  if (configParams.length > 0 && !opts.nonInteractive) {
    throw new CliError(
      'LLM config flags (--provider/--model/--base-url/--api-key-env) require --non-interactive; ' +
      'interactive start uses the setup wizard instead.',
      { code: START_USAGE_EXIT_CODE },
    );
  }
}

/** 非交互首次配置的缺参清单（空数组 = 完整可写）。 */
export function missingStartLLMParams(opts: StartLLMOptions): string[] {
  const missing: string[] = [];
  if (!opts.provider) missing.push('--provider');
  const hasKey = opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV];
  if (!hasKey) missing.push(`--api-key-env (or env ${START_LLM_API_KEY_ENV})`);
  if (opts.provider) {
    const preset = PRESETS[opts.provider];
    if (!preset) {
      throw new CliError(
        `Unknown provider preset "${opts.provider}". Available: ${Object.keys(PRESETS).join(', ')}`,
        { code: START_USAGE_EXIT_CODE },
      );
    }
    if (!preset.defaultBaseUrl && !opts.baseUrl) missing.push('--base-url (required for this provider)');
  }
  return missing;
}

/**
 * 解析非交互 API key 输入为配置值（${REF} 引用）。
 * --api-key-env 优先；否则 CHESTNUT_LLM_API_KEY 明文经 Credentials owner 落凭据文件。
 */
async function resolveNonInteractiveApiKey(
  deps: GateDeps,
  opts: StartLLMOptions,
  presetId: string,
): Promise<string> {
  if (opts.apiKeyEnv) {
    if (!process.env[opts.apiKeyEnv]) {
      throw new CliError(`Environment variable ${opts.apiKeyEnv} is not set`, { code: START_USAGE_EXIT_CODE });
    }
    return '${' + opts.apiKeyEnv + '}';
  }
  const raw = process.env[START_LLM_API_KEY_ENV];
  if (!raw) {
    throw new CliError(
      `Missing API key: pass --api-key-env <VAR> or set ${START_LLM_API_KEY_ENV}`,
      { code: START_USAGE_EXIT_CODE },
    );
  }
  const preset = PRESETS[presetId];
  return storeKeyAsCredential(deps, raw, { envVar: preset?.envVar, seed: presetId });
}

/**
 * 非交互配置输入落盘。
 * first-run：buildInitialConfig + saveGlobalExclusive（并发 loser 由 caller 重读重验）；
 * initialized：patchPrimary 部分字段（只覆盖显式给出的参数）。
 */
export async function applyStartLLMOptions(
  deps: GateDeps,
  opts: StartLLMOptions,
  phase: 'first-run' | 'initialized',
): Promise<void> {
  const presetId = opts.provider ?? deps.rootConfig.loadGlobal().llm.primary.preset;
  if (!presetId) {
    throw new CliError('--provider is required (no existing primary preset)', { code: START_USAGE_EXIT_CODE });
  }
  const apiKey = (opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV])
    ? await resolveNonInteractiveApiKey(deps, opts, presetId)
    : undefined;

  if (phase === 'first-run') {
    const missing = missingStartLLMParams(opts);
    if (missing.length > 0) {
      throw new CliError(
        `Missing required non-interactive params: ${missing.join(', ')}`,
        { code: START_USAGE_EXIT_CODE },
      );
    }
    // missingStartLLMParams 已保证 apiKey 可解析
    const config = buildInitialConfig({
      presetId,
      apiKey: apiKey!,
      model: opts.model ?? 'auto',
      baseUrl: opts.baseUrl,
    });
    deps.rootConfig.saveGlobalExclusive(config);
    deps.rootConfig.completeInitialization();
    return;
  }

  const patch: { preset?: string; model?: string; base_url?: string; api_key?: string } = {};
  if (opts.provider) patch.preset = opts.provider;
  if (opts.model) patch.model = opts.model;
  if (opts.baseUrl) patch.base_url = opts.baseUrl;
  if (apiKey) patch.api_key = apiKey;
  if (Object.keys(patch).length > 0) {
    await deps.rootConfig.patchPrimary(patch);
  }
}

/** 当前有效 primary 配置指纹（probe 与 chat 同一可证明快照的证据）。 */
export function primaryConfigFingerprint(deps: Pick<GateDeps, 'rootConfig'>): string {
  const primary = deps.rootConfig.loadGlobal().llm.primary;
  return JSON.stringify(primary);
}

async function probeOnce(
  deps: GateDeps,
): Promise<{ ok: true } | { ok: false; errorType: Parameters<typeof formatLLMError>[0]['errorType']; message: string; provider: string }> {
  const probe = await checkLLMConnection(deps);
  return probe.ok ? { ok: true } : { ok: false, errorType: probe.errorType, message: probe.message, provider: probe.provider };
}

/**
 * start LLM 验证门控。验证成功返回；失败/取消抛 CliError（非零退出码），
 * 调用方（start）不得继续 supervision/onboarding/chat。
 *
 * 快照一致性：verifyWithWizard 返回成功 probe 当时的 primary 指纹；门控收尾
 * 与当前指纹比对——并发外部改写意味着当前快照未验证，重验一次；仍漂移
 * fail-closed（不猜哪个配置进 chat）。
 */
export async function ensureStartLLMVerified(
  deps: GateDeps,
  opts: { audit?: AuditLog; interactive: boolean; preVerified: boolean },
): Promise<void> {
  const { audit, interactive } = opts;
  const verifiedFingerprint = opts.preVerified
    // init 刚对同一配置 probe 成功（同一进程、配置未再写）——复用事实不重复 probe
    ? primaryConfigFingerprint(deps)
    : await verifyWithWizard(deps, { audit, interactive });

  if (primaryConfigFingerprint(deps) !== verifiedFingerprint) {
    const reverified = await verifyWithWizard(deps, { audit, interactive });
    if (primaryConfigFingerprint(deps) !== reverified) {
      throw new CliError(
        'LLM config changed concurrently during start verification; refusing to proceed (fail-closed)',
        { code: START_GATE_EXIT_CODE },
      );
    }
  }
}

/**
 * 单次验证循环（probe → 失败时交互 retry/edit/cancel 或 非交互 loud 失败）。
 * 返回成功 probe 当时的 primary 配置指纹。
 */
async function verifyWithWizard(
  deps: GateDeps,
  opts: { audit?: AuditLog; interactive: boolean },
): Promise<string> {
  const { audit, interactive } = opts;
  audit?.write(CLI_AUDIT_EVENTS.START_PROBE_ATTEMPTED);
  const probe = await probeOnce(deps);
  if (probe.ok) {
    audit?.write(CLI_AUDIT_EVENTS.START_PROBE_SUCCEEDED);
    return primaryConfigFingerprint(deps);
  }
  audit?.write(
    CLI_AUDIT_EVENTS.START_PROBE_FAILED,
    `error_type=${probe.errorType}`,
    `message=${audit?.message(probe.message) ?? probe.message}`,
  );
  const errorLines = formatLLMError({
    errorType: probe.errorType,
    message: probe.message,
    provider: probe.provider,
    hint: LLM_ERROR_HINTS[probe.errorType],
  });

  if (!interactive) {
    errorLines.forEach(line => console.error(line));
    audit?.write(CLI_AUDIT_EVENTS.START_PROBE_ABORTED, 'reason=non_interactive');
    throw new CliError(
      `LLM verification failed (${probe.errorType}); start aborted (non-interactive)`,
      { code: START_GATE_EXIT_CODE },
    );
  }

  errorLines.forEach(line => console.log(line));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, ans => resolve(ans.trim())));
  try {
    // 向导内循环：retry / edit / cancel，失败不出向导（计划 §设计细节）
    while (true) {
      console.log('\nLLM verification failed. Choose:');
      console.log('1. Retry connection');
      console.log('2. Reconfigure (key / model / provider)');
      console.log('n. Cancel start');
      const choice = await question('\n> ');
      if (choice === '1') {
        console.log('Testing LLM connection...');
        const retry = await probeOnce(deps);
        if (retry.ok) {
          audit?.write(CLI_AUDIT_EVENTS.START_PROBE_SUCCEEDED, 'via=retry');
          console.log('✓ Connection successful!');
          return primaryConfigFingerprint(deps);
        }
        audit?.write(CLI_AUDIT_EVENTS.START_PROBE_FAILED, `via=retry`, `error_type=${retry.errorType}`);
        formatLLMError({
          errorType: retry.errorType,
          message: retry.message,
          provider: retry.provider,
          hint: LLM_ERROR_HINTS[retry.errorType],
        }).forEach(line => console.log(line));
        continue;
      }
      if (choice === '2') {
        const fixed = await promptReconfigure(deps, rl, probe.errorType);
        if (fixed) {
          audit?.write(CLI_AUDIT_EVENTS.START_PROBE_SUCCEEDED, 'via=reconfigure');
          return primaryConfigFingerprint(deps);
        }
        // reconfigure 内循环已展示失败详情；用户退出 reconfigure ≠ cancel start，回主菜单
        continue;
      }
      if (choice === 'n' || choice === 'N') {
        audit?.write(CLI_AUDIT_EVENTS.START_PROBE_ABORTED, 'reason=user_cancel');
        throw new CliError('LLM verification cancelled by user; start aborted', { code: START_GATE_EXIT_CODE });
      }
      console.log('Invalid choice.');
    }
  } finally {
    rl.close();
  }
}
