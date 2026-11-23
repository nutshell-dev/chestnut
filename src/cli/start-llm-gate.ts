/**
 * Phase 1925 Step E：start LLM 验证门控 + 非交互配置输入。
 * Phase 1926 Step C：验证事实升级为身份绑定——start 只允许「被 probe 的那份
 * 配置身份」进入 supervision/motion/onboarding/chat：
 * - probe 只消费显式 `LLMConfigSnapshot`（probe 内不再隐式读盘）；
 * - probe 成功后复核当前身份，漂移即丢弃结果并有界重验，持续漂移 fail-closed；
 * - init 交接 `VerifiedLLMConfig`（带 identity），身份不等不复用；
 * - 门控返回 VerifiedLLMConfig，start 把 identity 交给 daemon spawn，daemon
 *   装配前再次复核（见 daemon/startup 协议）。
 *
 * 铁律（计划 §设计细节）：
 * - start 只有在**当前有效配置**的真实 LLM 调用成功后才进入 supervision /
 *   motion / onboarding / chat；`.initialized` 只表示布局 ready，不是 probe 证据。
 * - probe 失败：交互模式留在向导内 retry/edit/cancel；非交互（--non-interactive
 *   或非 TTY）不进 readline，缺参/失败返回明确非零退出码。
 * - 任何 key 不进入 audit / stdout 错误预览（错误文本经 formatLLMError 截断；
 *   identity 是不含 secret 的 sha256 摘要）。
 *
 * 退出码约定：2 = 用法/缺参错误；3 = LLM 验证失败、身份漂移或用户取消（fail-closed）。
 */

import * as readline from 'readline';
import { llmProviderCatalog } from '../foundation/llm-provider/index.js';
type ApiFormat = llmProviderCatalog.ApiFormat;
import type { LLMConfigurationAdmin } from '../core/llm-configuration/index.js';
import {
  createAuthenticationCapability,
  snapshotLLMConfig,
  type LLMConfigSnapshot,
} from '../core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../core/llm-configuration/setup.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { AtomicWriteResult, FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { CliError } from './errors.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import {
  createExplicitSetupDraft,
  findSetupProvider,
  isCustomSetupChoice,
  makeExplicitSetupProvider,
  SETUP_PROVIDER_CATALOG,
  SETUP_PROVIDER_ORDER,
} from './setup-provider-catalog.js';
import { storeKeyAsCredential, type StoreKeyHooks } from './credentials-prompt.js';
import {
  probeLLMConnection,
  createProbeProviderFactory,
  promptReconfigure,
  formatLLMError,
  LLM_ERROR_HINTS,
  type VerifiedLLMConfig,
  type LLMErrorType,
} from './llm-connection-check.js';

export type { VerifiedLLMConfig } from './llm-connection-check.js';

/** start 的非交互配置参数（catalog 投影，与 commander camelCase 对应）。 */
export interface StartLLMOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** Custom 方法的显式 wire protocol（anthropic/openai/gemini）。 */
  apiFormat?: ApiFormat;
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

function reportDegradedConfigWrite(write: AtomicWriteResult): void {
  if (write.kind === 'durable') return;
  const errorSummary = formatErr(write.error).replace(/\s+/g, ' ').trim().slice(0, 240);
  console.error(`⚠ LLM primary config committed with degraded durability (kind=${write.kind}): ${errorSummary}`);
}

interface GateDeps {
  fsFactory(baseDir: string): FileSystem;
  llmConfiguration: Pick<LLMConfigurationAdmin, 'loadGlobal' | 'loadRaw' | 'store' | 'patchPrimary'>;
}

/** 给了配置参数但缺 --non-interactive → 用法错误（不猜意图、不静默忽略参数）。 */
export function validateStartLLMOptions(opts: StartLLMOptions): void {
  const configParams = [opts.provider, opts.model, opts.baseUrl, opts.apiFormat, opts.apiKeyEnv].filter(Boolean);
  if (configParams.length > 0 && !opts.nonInteractive) {
    throw new CliError(
      'LLM config flags (--provider/--model/--base-url/--api-format/--api-key-env) require --non-interactive; ' +
      'interactive start uses the setup wizard instead.',
      { code: START_USAGE_EXIT_CODE },
    );
  }
}

/**
 * 非交互首次配置的缺参清单（空数组 = 完整可写）。
 * Phase 1926 Step D：api key 仅 api_key profile 必需——ambient（AWS 链/ADC/env）
 * 与 OAuth preset 无 key 也可写配置（probe 期由 pi-ai 原生 auth 裁决，失败 exit 3）；
 * base-url 仅无默认 baseUrl 且无 catalog 权威的 custom preset 必需。
 */
export function missingStartLLMParams(opts: StartLLMOptions): string[] {
  const missing: string[] = [];
  if (!opts.provider) {
    missing.push('--provider');
  } else {
    const setup = findSetupProvider(opts.provider);
    if (!setup) {
      throw new CliError(
        `Unknown configuration method "${opts.provider}". Available: ${SETUP_PROVIDER_ORDER.join(', ')}`,
        { code: START_USAGE_EXIT_CODE },
      );
    }
    if (isCustomSetupChoice(setup)) {
      if (!opts.apiFormat) missing.push('--api-format (required for custom provider)');
      if (!opts.baseUrl) missing.push('--base-url (required for custom provider)');
      if (!opts.model) missing.push('--model (required for custom provider)');
    }
  }
  const hasKey = opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV];
  if (!hasKey) missing.push(`--api-key-env (or env ${START_LLM_API_KEY_ENV})`);
  return missing;
}

/**
 * 解析非交互 API key 输入为配置值（${REF} 引用）。
 * --api-key-env 优先；否则 CHESTNUT_LLM_API_KEY 明文经 Credentials owner 落凭据文件。
 * Phase 1976：首次配置向导复用同一实现，经 hooks 记录本次新建的凭据条目。
 */
export async function resolveNonInteractiveApiKey(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  opts: StartLLMOptions,
  credential: { envVar?: string; seed: string },
  hooks?: StoreKeyHooks,
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
  return storeKeyAsCredential(deps, raw, credential, hooks);
}

/**
 * 已初始化 workspace 的非交互配置输入：patchPrimary 部分字段（只覆盖显式给出的参数）。
 * Phase 1976：首次配置不再经此写入——由 first-run-setup 的 draft→probe→commit 负责。
 */
export async function applyStartLLMOptions(
  deps: GateDeps,
  opts: StartLLMOptions,
): Promise<void> {
  const setup = opts.provider ? findSetupProvider(opts.provider) : undefined;
  if (opts.provider) {
    if (!setup) {
      throw new CliError(
        `Unknown configuration method "${opts.provider}". Available: ${SETUP_PROVIDER_ORDER.join(', ')}`,
        { code: START_USAGE_EXIT_CODE },
      );
    }
    const missing = missingStartLLMParams(opts);
    if (missing.length > 0) {
      throw new CliError(`Missing required non-interactive params: ${missing.join(', ')}`, {
        code: START_USAGE_EXIT_CODE,
      });
    }
    const apiKey = await resolveNonInteractiveApiKey(deps, opts, {
      envVar: setup.envVar,
      seed: setup.id,
    });
    const draft = createExplicitSetupDraft(setup, {
      apiKey,
      model: opts.model ?? setup.defaultModel ?? '',
      ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
      ...(opts.apiFormat !== undefined && { apiFormat: opts.apiFormat }),
    });
    reportDegradedConfigWrite(await deps.llmConfiguration.patchPrimary({
      ...makeExplicitSetupProvider(draft),
      preset: undefined,
    }));
    return;
  }
  const providerRef = opts.provider ?? deps.llmConfiguration.loadGlobal().llm.primary.provider_id;
  if (!providerRef) {
    throw new CliError('--provider is required (no existing primary provider)', { code: START_USAGE_EXIT_CODE });
  }
  // Without --provider this is a narrow patch of the existing explicit primary.
  // Legacy preset documents have already crossed the L4 migration boundary; never
  // reinterpret their alias or synthesize provider/protocol defaults here.
  const currentSetup = SETUP_PROVIDER_CATALOG.find(choice => choice.providerId === providerRef);
  const apiKey = (opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV])
    ? await resolveNonInteractiveApiKey(deps, opts, {
      envVar: currentSetup?.envVar,
      seed: currentSetup?.id ?? providerRef,
    })
    : undefined;

  const patch: { model?: string; base_url?: string; api_key?: string } = {};
  if (opts.model) patch.model = opts.model;
  if (opts.baseUrl) patch.base_url = opts.baseUrl;
  if (apiKey) patch.api_key = apiKey;
  if (Object.keys(patch).length > 0) {
    reportDegradedConfigWrite(await deps.llmConfiguration.patchPrimary(patch));
  }
}

/** 读取当前有效配置为不可变快照（resolve 与 identity 同源派生）。 */
function readLLMSnapshot(deps: Pick<GateDeps, 'llmConfiguration' | 'fsFactory'>): LLMConfigSnapshot {
  return snapshotLLMConfig(deps.llmConfiguration.loadGlobal(), undefined, {
    credentials: createAuthenticationCapability({ fsFactory: deps.fsFactory }),
  });
}

/** probe 成功后配置持续漂移的有界重验预算；耗尽 fail-closed（不猜身份）。 */
const MAX_SNAPSHOT_DRIFT_ATTEMPTS = 3;

type ProbeFailure = { ok: false; errorType: LLMErrorType; message: string; provider: string };

/**
 * 对快照 probe 并在成功后复核当前身份；漂移丢弃结果、以新快照重验（有界）。
 * 覆盖 Step A 复现的 change_during_probe 窗口：probe 期间 A→B 时 B 不得
 * 冒充 A 的验证事实——B 会被重新 probe 或最终 fail-closed。
 */
async function probeUntilStable(
  deps: GateDeps,
  audit: AuditLog | undefined,
  snapshot: LLMConfigSnapshot,
  via?: 'retry',
): Promise<{ verified: VerifiedLLMConfig } | { failure: ProbeFailure }> {
  let current = snapshot;
  // 整轮重验共用同一 setup 与固定 provider/store 组合，不引入全局 singleton。
  const providerFactory = createProbeProviderFactory(
    createAuthenticationSetup({ fsFactory: deps.fsFactory }),
  );
  for (let attempt = 0; attempt < MAX_SNAPSHOT_DRIFT_ATTEMPTS; attempt++) {
    audit?.write(CLI_AUDIT_EVENTS.START_PROBE_ATTEMPTED);
    const probe = await probeLLMConnection(current, { providerFactory });
    if (!probe.ok) {
      return { failure: { ok: false, errorType: probe.errorType, message: probe.message, provider: probe.provider } };
    }
    const now = readLLMSnapshot(deps);
    if (now.operationalIdentity === current.operationalIdentity) {
      audit?.write(CLI_AUDIT_EVENTS.START_PROBE_SUCCEEDED, ...(via ? [`via=${via}`] : []));
      return { verified: { snapshot: current, probe: { model: probe.model }, via: 'start' } };
    }
    audit?.write(
      CLI_AUDIT_EVENTS.START_PROBE_FAILED,
      `reason=snapshot_drift`,
      `attempt=${attempt + 1}`,
    );
    current = now;
  }
  throw new CliError(
    'LLM config changed concurrently during start verification; refusing to proceed (fail-closed)',
    { code: START_GATE_EXIT_CODE },
  );
}

/**
 * start LLM 验证门控。验证成功返回 VerifiedLLMConfig（start 据此把 identity
 * 交给 daemon spawn）；失败/取消抛 CliError（非零退出码），调用方（start）
 * 不得继续 supervision/onboarding/chat。
 *
 * preVerified（init 交接）：只有 identity 与当前快照相等才复用——覆盖 Step A
 * 复现的 stale_init_boolean 窗口；不等即全量重验，不存在无身份放行。
 */
export async function ensureStartLLMVerified(
  deps: GateDeps,
  opts: { audit?: AuditLog; interactive: boolean; preVerified?: VerifiedLLMConfig },
): Promise<VerifiedLLMConfig> {
  const { audit, interactive, preVerified } = opts;
  if (preVerified) {
    const now = readLLMSnapshot(deps);
    if (now.operationalIdentity === preVerified.snapshot.operationalIdentity) {
      return preVerified;
    }
    audit?.write(CLI_AUDIT_EVENTS.START_PROBE_FAILED, `reason=stale_preverified_identity`);
  }
  return verifyWithWizard(deps, { audit, interactive });
}

/**
 * 单次验证循环（probe → 失败时交互 retry/edit/cancel 或 非交互 loud 失败）。
 */
async function verifyWithWizard(
  deps: GateDeps,
  opts: { audit?: AuditLog; interactive: boolean },
): Promise<VerifiedLLMConfig> {
  const { audit, interactive } = opts;
  let result = await probeUntilStable(deps, audit, readLLMSnapshot(deps));

  while (!('verified' in result)) {
    const failure = result.failure;
    audit?.write(
      CLI_AUDIT_EVENTS.START_PROBE_FAILED,
      `error_type=${failure.errorType}`,
      `message=${audit?.message(failure.message) ?? failure.message}`,
    );
    const errorLines = formatLLMError({
      errorType: failure.errorType,
      message: failure.message,
      provider: failure.provider,
      hint: LLM_ERROR_HINTS[failure.errorType],
    });

    if (!interactive) {
      errorLines.forEach(line => console.error(line));
      audit?.write(CLI_AUDIT_EVENTS.START_PROBE_ABORTED, 'reason=non_interactive');
      throw new CliError(
        `LLM verification failed (${failure.errorType}); start aborted (non-interactive)`,
        { code: START_GATE_EXIT_CODE },
      );
    }

    errorLines.forEach(line => console.log(line));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt: string): Promise<string> =>
      new Promise(resolve => rl.question(prompt, ans => resolve(ans.trim())));
    try {
      // 向导内循环：retry / edit / cancel，失败不出向导（计划 §设计细节）
      while (!('verified' in result)) {
        console.log('\nLLM verification failed. Choose:');
        console.log('1. Retry connection');
        console.log('2. Reconfigure (key / model / provider)');
        console.log('n. Cancel start');
        const choice = await question('\n> ');
        if (choice === '1') {
          console.log('Testing LLM connection...');
          result = await probeUntilStable(deps, audit, readLLMSnapshot(deps), 'retry');
          if ('verified' in result) {
            console.log('✓ Connection successful!');
          } else {
            formatLLMError({
              errorType: result.failure.errorType,
              message: result.failure.message,
              provider: result.failure.provider,
              hint: LLM_ERROR_HINTS[result.failure.errorType],
            }).forEach(line => console.log(line));
          }
          continue;
        }
        if (choice === '2') {
          const reconfigured = await promptReconfigure(deps, rl, failure.errorType);
          if (reconfigured) {
            // reconfigure 已对返回快照 probe 成功；复核当前身份后才算验证事实
            const now = readLLMSnapshot(deps);
            if (now.operationalIdentity === reconfigured.operationalIdentity) {
              audit?.write(CLI_AUDIT_EVENTS.START_PROBE_SUCCEEDED, 'via=reconfigure');
              result = { verified: { snapshot: reconfigured, probe: { model: reconfigured.config.primary.model }, via: 'start' } };
            } else {
              audit?.write(CLI_AUDIT_EVENTS.START_PROBE_FAILED, `reason=snapshot_drift`, `attempt=reconfigure`);
              result = await probeUntilStable(deps, audit, now, 'retry');
            }
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
  return result.verified;
}
