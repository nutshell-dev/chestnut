/**
 * init command - Initialize chestnut workspace
 */

import * as readline from 'readline';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { RootConfigAdmin } from '../../assembly/index.js';
import { GlobalConfigAlreadyExistsError, snapshotLLMConfig, createUserPiAiCredentialStore } from '../../assembly/index.js';
import { FORMAT_MAP } from '../../foundation/llm-orchestrator/index.js';
import { passwordQuestion } from '../utils/password-prompt.js';
import { CliError } from '../errors.js';
import { PRESETS } from '../../foundation/llm-provider/index.js';
import { SETUP_PROVIDER_CATALOG, type SetupProviderChoice } from '../setup-provider-catalog.js';
import {
  setupProviderMenuLines,
  setupDraftPreviewLines,
  SETUP_WELCOME,
  SETUP_OTHER_FORMAT_LINES,
  SETUP_CANCELLED,
} from '../../templates/messages/index.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RESET_TIMEOUT_MS,
  INIT_LLM_IDLE_TIMEOUT_MS,
} from '../../foundation/llm-orchestrator/index.js';

import { DEFAULT_MAX_CONCURRENT_TASKS } from '../../core/async-task-system/index.js';
// phase 1870: heartbeat 字段声明归 Heartbeat owner——init 模板默认值由 schema 常量派生（无二处字面值）。
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from '../../core/heartbeat/index.js';
// phase 1485: chestnut init 生成的 config 不再写 max_steps 字段 — agent-executor 自持默认值、user 需覆盖时再加。
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { probeLLMConnection, promptReconfigure, formatLLMError, LLM_ERROR_HINTS, type VerifiedLLMConfig } from '../llm-connection-check.js';
// Phase 1925 Step B：明文 key 不落 root config —— 经 Credentials owner 落用户级凭据文件、配置写 `${REF}`。
import { storeKeyAsCredential } from '../credentials-prompt.js';

interface InitCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'isInitialized' | 'loadGlobal' | 'saveGlobal' | 'saveGlobalExclusive' | 'patchPrimary' | 'getInitializationState' | 'completeInitialization'>;
}

/**
 * init 结果（Phase 1926 Step C）：`verified` 是带配置身份的已验证事实——
 * init 本次对**该快照**完成真实 LLM 调用验证；start 门控仅在 identity 与当前
 * 快照相等时复用（取代 Phase 1925 的无主 boolean）。早退（already ready /
 * 并发 loser / transient warn-continue / 用户退出 reconfigure）一律缺席——
 * 未验证事实不猜。
 */
export interface InitCommandResult {
  verified?: VerifiedLLMConfig;
}

/**
 * 初始 global config 模板（Phase 1925 Step E 提取单源）：init 交互向导与
 * start --non-interactive 首次配置共用，字段默认值不得两处漂移。
 */
export function buildInitialConfig(input: {
  /** preset 别名（与 providerId 互斥——显式 catalog 入口优先）。 */
  presetId?: string;
  /** Phase 1927 Step D：显式 catalog provider id（无 preset 别名时的配置入口）。 */
  providerId?: string;
  /** Phase 1926 Step D：ambient/oauth preset 无 api_key（缺席 = 不落该字段）。 */
  apiKey?: string;
  model: string;
  baseUrl?: string;
}) {
  const primary = {
    ...(input.providerId ? { provider_id: input.providerId } : { preset: input.presetId }),
    ...(input.apiKey && { api_key: input.apiKey }),
    model: input.model,
    temperature: 0.7,
    timeout_ms: DEFAULT_LLM_TIMEOUT_MS,
    ...(input.baseUrl && { base_url: input.baseUrl }),
  };
  return {
    version: '1',
    llm: {
      primary,
      retry_attempts: DEFAULT_LLM_RETRY_ATTEMPTS,
      retry_delay_ms: DEFAULT_RETRY_DELAY_MS,
      // Phase 1268 Step E: 默认启用 circuit breaker，显式落盘便于用户观察。
      circuit_breaker: {
        failure_threshold: 3,
        reset_timeout_ms: DEFAULT_RESET_TIMEOUT_MS,
      },
    },
    tool_timeout_ms: 60_000,
    // Phase 1289 Step D: root YAML 不再写 watchdog 段 — fresh init 的默认值由
    // initWorkspaceWatchdogConfig 落入 .chestnut/watchdog/config.yaml；
    // log_archive_days 随块显式退役（捕获进迁移 journal retired_fields）。
    motion: {
      heartbeat_interval_ms: HEARTBEAT_DEFAULT_INTERVAL_MS,
      // phase 1485: max_steps 不写入初始 config — agent-executor 持默认值、user 显式覆盖时再设。
      max_concurrent_tasks: DEFAULT_MAX_CONCURRENT_TASKS,
      llm_idle_timeout_ms: INIT_LLM_IDLE_TIMEOUT_MS,
    },
  };
}

export async function initCommand(deps: InitCommandDeps, silent = false, extraDeps?: { audit?: AuditLog }): Promise<InitCommandResult> {
  const audit = extraDeps?.audit;
  // Phase 1911 Step D（RACE-CONFIG-INIT-PARTIAL-PUBLISH）：typed 初始化状态。
  // ready 依据 = root config + ready marker + 必需布局核验，不是 root YAML exists。
  const initState = deps.rootConfig.getInitializationState();
  if (initState === 'ready') {
    console.log('✓ Already initialized (.chestnut/config.yaml exists)');
    return {};
  }
  if (initState === 'invalid') {
    throw new CliError(
      'Workspace initialization state is invalid: root config or workspace layout ' +
      'is corrupted. Inspect .chestnut/ manually; init will not overwrite it.',
    );
  }
  if (initState === 'in_progress') {
    // 崩溃窗口 / legacy 无 marker 布局：幂等补建后发布 ready，不重新交互、
    // 不覆盖合法配置；LLM probe 不属于 ready，恢复路径不重跑（可用 config 命令修复）。
    deps.rootConfig.completeInitialization();
    console.log('✓ Initialization completed (resumed an interrupted bootstrap; existing config kept)');
    return {};
  }

  console.log('Initializing chestnut...\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string, defaultValue?: string): Promise<string> => {
    return new Promise((resolve) => {
      const fullPrompt = defaultValue
        ? `${prompt} (default: ${defaultValue}): `
        : `${prompt}: `;
      rl.question(fullPrompt, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  };

  try {
    let presetId = '';
    let providerId = '';
    let apiKey = '';
    let model = '';
    let baseUrl: string | undefined;

    console.log(SETUP_WELCOME.trimEnd());
    setupProviderMenuLines(SETUP_PROVIDER_CATALOG).forEach(line => console.log(line));

    let selected: SetupProviderChoice | undefined;
    while (!selected) {
      const raw = await question('\n> ');
      const idx = parseInt(raw, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= SETUP_PROVIDER_CATALOG.length) {
        console.log('Invalid choice.');
        continue;
      }
      selected = SETUP_PROVIDER_CATALOG[idx];
    }
    const chosen = selected;

    if (chosen.auth === 'advanced') {
      // Other: explicit API format + base URL + key + model.
      SETUP_OTHER_FORMAT_LINES.forEach(line => console.log(line));
      const fmt = await question('\n> ', '2');
      presetId = FORMAT_MAP[fmt] ?? '';
      if (!presetId) throw new CliError('Invalid API format');
      baseUrl = await question('Base URL');
      if (!baseUrl) throw new CliError('Base URL is required');
      const rawKey = await passwordQuestion(rl, 'API Key: ');
      if (!rawKey) throw new CliError('API Key is required');
      apiKey = await storeKeyAsCredential(deps, rawKey, { seed: presetId });
      model = await question('Model');
      if (!model) throw new CliError('Model is required');
    } else {
      presetId = chosen.target.preset ?? '';
      const preset = PRESETS[presetId];
      if (!preset) throw new CliError(`Internal provider mapping missing for ${chosen.label}`);
      if (chosen.auth === 'api_key') {
        const envReady = Boolean(preset.envVar && process.env[preset.envVar]);
        const hint = envReady ? ` (press Enter to use ${preset.envVar})` : '';
        const rawKey = await passwordQuestion(rl, `API Key${hint}: `);
        if (!rawKey && envReady && preset.envVar) {
          apiKey = '${' + preset.envVar + '}';
          console.log(`✓ Will read from ${preset.envVar} at runtime`);
        } else if (!rawKey) {
          throw new CliError('API Key is required');
        } else {
          apiKey = await storeKeyAsCredential(deps, rawKey, { envVar: preset.envVar, seed: presetId });
        }
      } else if (chosen.auth === 'local') {
        console.log(`ℹ ${chosen.label}: local provider, no API key required.`);
      }
      model = await question(
        `Model${preset.defaultModel ? ` (default: ${preset.defaultModel})` : ''}`,
        preset.defaultModel ?? '',
      );
      if (!model) throw new CliError('Model is required');
    }

    setupDraftPreviewLines({
      label: chosen.label,
      model,
      auth: chosen.auth === 'local' ? 'local' : 'API key',
      role: 'primary',
      ...(baseUrl && { baseUrl }),
      ...(apiKey && { keyRef: apiKey }),
    }).forEach(line => console.log(line));

    const saveAnswer = await question('\nSave this configuration? [Y/n]', 'Y');
    if (saveAnswer.toLowerCase() === 'n') {
      console.log(SETUP_CANCELLED);
      return {};
    }

    // Build config（模板单源：buildInitialConfig，与 start --non-interactive 共用）
    const config = buildInitialConfig({ ...(providerId ? { providerId } : { presetId }), apiKey, model, baseUrl });

    // Save config
    // Phase 1910 Step D（RACE-CONFIG-INIT-LOST-UPDATE）：初始化唯一提交点 ——
    // O_EXCL 独占创建；并发 init winner 已提交时 loser 关闭交互、重读事实返回，
    // 绝不以后写覆盖先写。
    try {
      deps.rootConfig.saveGlobalExclusive(config);
    } catch (err) {
      if (err instanceof GlobalConfigAlreadyExistsError) {
        // Phase 1911 Step D：winner 可能仍在 bootstrap 窗口 —— loser 幂等协助
        // 收敛（owner 物化幂等，不覆盖 winner 配置），随后按事实返回。
        deps.rootConfig.completeInitialization();
        console.log('✓ Already initialized (a concurrent init completed first; keeping its config)');
        // 并发 loser：未验证 winner 配置——verified 缺席交由 start 门控重读重验
        return {};
      }
      throw err;
    }

    // Phase 1911 Step D：完整 bootstrap（audit/watchdog config、layout、logs）
    // 由各 owner 幂等物化并核验后，才发布 ready marker —— initialized 对外
    // 可见性不再先于必需布局。
    deps.rootConfig.completeInitialization();

    // Phase 1927 Step E：probe 共用装配创建的 CredentialStore。
    // Phase 1972：首屏目录不含 OAuth provider；OAuth 登录仍走 `config provider login`。
    const piAiCredentials = createUserPiAiCredentialStore({ fsFactory: deps.fsFactory });

    // ── Verify LLM API reachable ─────────────────────────────────────────────
    // Per DP「事后审计」+ DP「智能体是决策主体」(init 阶段 user 主体):
    // probe 真实 LLM、失败给 user 错误类型 + reconfigure 选项。
    console.log('\nTesting LLM connection...');
    audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_ATTEMPTED, `preset=${presetId || providerId}`, `model=${model}`);
    const t0 = Date.now();
    // Phase 1926 Step C：读取即快照，probe 只消费该快照——结果携带身份证据
    const snapshot = snapshotLLMConfig(deps.rootConfig.loadGlobal());
    const probe = await probeLLMConnection(snapshot, { credentials: piAiCredentials });
    const latencyMs = Date.now() - t0;
    // Phase 1926 Step C：probe 事实（带 identity）经返回值交给 start 门控
    let verified: VerifiedLLMConfig | undefined;
    if (probe.ok) {
      verified = { snapshot, probe: { model: probe.model }, via: 'init' };
      audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SUCCEEDED, `preset=${presetId || providerId}`, `model=${probe.model}`, `latency_ms=${latencyMs}`);
      console.log(`✓ ${probe.model} (${latencyMs}ms)`);
    } else {
      audit?.write(
        CLI_AUDIT_EVENTS.INIT_PROBE_FAILED,
        `preset=${presetId || providerId}`,
        `error_type=${probe.errorType}`,
        `message=${audit?.message(probe.message) ?? probe.message}`,
      );
      formatLLMError({
        errorType: probe.errorType,
        message: probe.message,
        hint: LLM_ERROR_HINTS[probe.errorType],
      }).forEach(line => console.log(line));

      if (probe.errorType === 'auth' || probe.errorType === 'model') {
        // actionable errors → 提供 reconfigure 选项（成功返回已 probe 的新快照）
        const fixed = await promptReconfigure(deps, rl, probe.errorType);
        if (fixed) {
          verified = { snapshot: fixed, probe: { model: fixed.config.primary.model }, via: 'init' };
          audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_RECONFIGURED, `preset=${presetId || providerId}`);
        } else {
          audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, `preset=${presetId}`, `reason=user_exit_reconfigure`);
          console.log('⚠ LLM not verified. Run "chestnut config" later to fix.');
        }
      } else {
        // network / rate_limit / unknown — 可能 transient、warn 不阻断
        // phase 324 H2: 不阻断流程（config 仍写）但设非 0 exit code、
        // 让 CI / 自动化能感知探测失败、避免静默 exit 0 制造假绿。
        audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, `preset=${presetId}`, `reason=transient_${probe.errorType}`);
        console.log('⚠ Continuing anyway — fix later with "chestnut config" if needed.');
        process.exitCode = 2;
      }
    }

    audit?.write(CLI_AUDIT_EVENTS.INIT_DONE);
    if (process.exitCode && process.exitCode !== 0) {
      console.log('\n⚠ Initialized with warnings (LLM probe failed). Re-run "chestnut config" once provider is reachable.');
    } else {
      console.log('\n✓ Initialized successfully!');
    }
    if (!silent) {
      console.log('\nNext steps:');
      console.log('1. Create a Claw: chestnut claw <name> create');
      console.log('2. Start chatting: chestnut claw <name> chat');
    }
    return { verified };

  } catch (error) {
    // phase 446 (review N3-H2): 内部已是 CliError 时直接重抛、不双包污染原文案
    if (error instanceof CliError) throw error;
    // phase 526: 保 cause、事后可还原 root error stack
    throw new CliError(`Init failed: ${formatErr(error)}`, { cause: error });
  } finally {
    rl.close();
  }
}
