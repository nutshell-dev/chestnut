/**
 * config command - Manage LLM provider configuration
 */

import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import type { RootConfigAdmin } from '../../assembly/index.js';
import type {
  LLMConfigurationAdmin,
  LLMGlobalConfigView,
} from '../../core/llm-configuration/index.js';
import {
  createAuthenticationCapability,
  createLLMNotificationStore,
  classifyApiKeyConfigValue,
  runLLMSetupWorkflow,
  type LLMSetupWorkflowEvent,
} from '../../core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../core/llm-configuration/setup.js';
import { llmProviderCatalog } from '../../foundation/llm-provider/index.js';
const { PRESETS, presetRequiresBaseUrl, catalogProvidersWithoutPreset } = llmProviderCatalog;
// Phase 1927 Step D：catalog-only provider 选择与派生 profile（显式 catalog 配置入口）

import { createProcessManagerForCLI, describeLiveness } from '../../foundation/process-manager/index.js';
import { CliError } from '../errors.js';
// phase 1874 Step B: 终端文本原语经 viewport 模块 barrel（CLIProtocol 有 zod-only bare 白名单、不容 string-width）
import { fitLine } from '../../viewport/index.js';
import { cliAction, type SupervisionPolicy } from '../supervision-policy.js';
import { DEFAULT_TERMINAL_WIDTH } from '../../viewport/index.js';
import { FORMAT_MAP } from '../provider-format-map.js';
import {
  resolveClawDaemonDir,
  MOTION_CLAW_ID,
  requireMotionAccess,
} from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { formatErr, sha256Hex } from '../../foundation/node-utils/index.js';
import type { AtomicWriteResult, FileSystem } from '../../foundation/fs/index.js';
// phase 320: hot-reload — CLI 投递 reload_llm_config 给运行中 daemon
import { makeClawNotifyTargetResolver } from '../../core/claw-topology/index.js';
import { createClawNotifier } from '../../foundation/messaging/index.js';
import { CLAWS_DIR, enumerateClaws, getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { actionAuditFor } from '../action-scope.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from '../../core/runtime/index.js';
import {
  CONFIG_RELOAD_NOTICE,
  SETUP_OTHER_FORMAT_LINES,
  SETUP_CANCELLED,
  SETUP_CONFIRM_PROMPT,
  SETUP_PROBE_FAILED_NOT_SAVED,
  setupApiKeyPrompt,
  setupConnectingLine,
  setupDraftPreviewLines,
} from '../../templates/messages/index.js';
import { checkLLMConnection, promptReconfigure, formatLLMError, LLM_ERROR_HINTS } from '../llm-connection-check.js';
// Phase 2206 Step C：明文 key 不落 root config —— 经 Credentials owner 落 workspace 凭据文件、配置写 `${REF}`。
import { storeKeyAsCredential } from '../credentials-prompt.js';
import {
  discardCreatedCredentials,
  promptRepairAction,
  recordCreatedCredential,
  type StoredCredential,
} from '../first-run-setup.js';
import {
  SETUP_PROVIDER_CATALOG,
  describeEffectiveThinking,
  isCustomSetupChoice,
  makeExplicitSetupDraft,
  describeExplicitSetupTarget,
  explicitSetupTargetRequiresBaseUrl,
  type SetupProviderChoice,
} from '../setup-provider-catalog.js';
import {
  emitLLMSetupWorkflowAudit,
  formatSetupProbeFailureLines,
  makeLLMSetupWorkflowProbe,
  recheckLLMSetupIdentity,
} from '../setup-provider-probe.js';
import { passwordQuestion } from '../utils/password-prompt.js';
import { question } from '../utils/prompt.js';
import { shapeCommand, getConfigCommandSpec, type CommandShapeSpec } from '../../cli-protocol/index.js';
// Phase 1926 Step D：provider login/logout 运行缝（pi-ai 原生 login 流 + Credentials owner 持久化）
import { runProviderLogin, runProviderLogout, providerLoginTypes, type ProviderLoginType } from '../llm-login.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';
import {
  formatAmbiguousProviderReference,
  formatProviderTarget,
  providerEntryFor,
  providerLabelExists,
  resolveProviderReference,
  type ResolvedProviderReference,
} from './provider-reference.js';

function reportDegradedConfigWrite(target: string, write: AtomicWriteResult): void {
  if (write.kind === 'durable') return;
  const errorSummary = formatErr(write.error).replace(/\s+/g, ' ').trim().slice(0, 240);
  console.error(`⚠ ${target} committed with degraded durability (kind=${write.kind}): ${errorSummary}`);
}

/**
 * phase 320: 通知所有运行中的 daemon（motion + 所有 claws）重新加载 LLM 配置。
 * Producer 侧 / consumer 侧在 Runtime._drainOwnInbox 拦截路径。
 *
 * - daemon 不存活 → silent skip（下次启动自然读新配置）
 * - notifyClaw 失败 silent（按现有 messaging 语义、不阻 CLI）
 */
export async function notifyRunningDaemons(
  deps: {
    fsFactory: (baseDir: string) => FileSystem;
    llmConfiguration: Pick<LLMConfigurationAdmin, 'readRevision'>;
  },
  source: string,
  committedRevision?: { readonly id: string },
): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('configure'), 'configure', 'config/provider');
  const chestnutRoot = getChestnutRoot();
  const pm = createProcessManagerForCLI({ ...deps, baseDir: chestnutRoot });
  const rootFs = deps.fsFactory(chestnutRoot);
  const audit = actionAuditFor(chestnutRoot, deps);
  const revision = committedRevision?.id ?? deps.llmConfiguration.readRevision().id;
  const notifications = createLLMNotificationStore(deps);
  const recordNotification = (
    target: string,
    status: 'pending' | 'sent' | 'failed' | 'offline',
    error?: unknown,
  ): void => {
    try {
      const write = notifications.record({ revision, target, status, ...(error !== undefined ? { error } : {}) });
      reportDegradedConfigWrite(`LLM notification fact for ${target}`, write);
    } catch (persistenceError) {
      // 配置与消息发送结果均不因记账失败被伪装成未提交；明确显示独立故障。
      console.error(
        `LLM notification fact persistence failed for ${target}: ${formatErr(persistenceError)}`,
      );
    }
  };

  const candidates: string[] = [MOTION_CLAW_ID];
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);
  if (rootFs.existsSync(clawsDir)) {
    const subFs = deps.fsFactory(clawsDir);
    candidates.push(...enumerateClaws(subFs, '.'));
  }

  let notified = 0;
  const clawNotifier = createClawNotifier({
    fs: rootFs,
    audit,
    resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
  });
  for (const id of candidates) {
    const clawId = id === MOTION_CLAW_ID ? MOTION_CLAW_ID : makeClawId(id);
    const liveness = pm.liveness(resolveClawDaemonDir(
      clawId,
      getCapturedCliMotionAccess('configure'),
      'configure',
    ));
    if (liveness.kind === 'dead' || liveness.kind === 'absent') {
      recordNotification(id, 'offline');
      continue;
    }
    if (liveness.kind !== 'alive') {
      // 证据损坏/probe 不可用不是 offline；保留可诊断失败，且不向状态不明的 daemon 投递。
      recordNotification(id, 'failed', describeLiveness(liveness));
      continue;
    }
    recordNotification(id, 'pending');
    try {
      await clawNotifier.notifyAsync(id, {
        type: RELOAD_LLM_CONFIG_MESSAGE_TYPE,
        source: `cli-${source}`,
        priority: 'high',
        body: CONFIG_RELOAD_NOTICE,
        messageId: `llm-reload-${revision}-${sha256Hex(id).slice(0, 16)}`,
        metadata: { llm_revision: revision },
      });
      recordNotification(id, 'sent');
      notified++;
    } catch (error) {
      // silent: 保存已成功且通知失败已持久化，daemon 启动仍会从 saved revision 重放应用。
      recordNotification(id, 'failed', error);
    }
  }

  if (notified > 0) {
    console.log(`✓ Notified ${notified} running daemon(s) to reload LLM config`);
  }
}

// Preset choices for interactive selection
const PRESET_CHOICES = Object.entries(PRESETS).map(([id, preset], index) => ({
  num: index + 1,
  id,
  displayName: preset.displayName,
  // Phase 1926 Step D：catalog preset（piAiProvider）endpoint 由 catalog 裁决，不索 baseUrl
  needsBaseUrl: presetRequiresBaseUrl(preset),
}));

// Phase 1927 Step D：无 preset 别名的 catalog provider 附加在选择尾部（inventory 单源
// 派生，消除 provider universe 与 PRESETS 双重封闭）；catalog 选择无默认 model。
const CATALOG_CHOICES = catalogProvidersWithoutPreset().map((id, index) => ({
  num: PRESET_CHOICES.length + index + 1,
  id,
}));

// Helper to create readline interface
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// Select preset interactively
// Phase 1927 Step D：返回判别选择（preset 别名 或 显式 catalog provider id）。
async function selectPreset(rl: readline.Interface): Promise<{ kind: 'preset'; id: string } | { kind: 'catalog'; id: string }> {
  console.log('\nSelect preset:');
  // Display in two columns
  const half = Math.ceil(PRESET_CHOICES.length / 2);
  for (let i = 0; i < half; i++) {
    const left = PRESET_CHOICES[i];
    const right = PRESET_CHOICES[i + half];
    const leftStr = `${left.num}. ${left.id.padEnd(18)}`;
    const rightStr = right ? `${right.num}. ${right.id}` : '';
    console.log(`  ${leftStr}  ${rightStr}`);
  }
  if (CATALOG_CHOICES.length > 0) {
    console.log('  ── pi-ai catalog providers (explicit provider_id, model required) ──');
    const halfC = Math.ceil(CATALOG_CHOICES.length / 2);
    for (let i = 0; i < halfC; i++) {
      const left = CATALOG_CHOICES[i];
      const right = CATALOG_CHOICES[i + halfC];
      const leftStr = `${left.num}. ${left.id.padEnd(28)}`;
      const rightStr = right ? `${right.num}. ${right.id}` : '';
      console.log(`  ${leftStr}  ${rightStr}`);
    }
  }

  const answer = await question(rl, '\n> ');
  const num = parseInt(answer, 10);
  if (isNaN(num)) { throw new CliError('Invalid choice: not a number'); }
  const choice = PRESET_CHOICES.find(c => c.num === num);
  if (choice) return { kind: 'preset', id: choice.id };
  const catalogChoice = CATALOG_CHOICES.find(c => c.num === num);
  if (catalogChoice) return { kind: 'catalog', id: catalogChoice.id };
  throw new CliError('Invalid selection');
}

function requireProviderReference(
  config: LLMGlobalConfigView,
  reference: string,
  notFoundMessage = `Provider "${reference}" not found`,
): ResolvedProviderReference {
  const resolution = resolveProviderReference(config, reference);
  if (resolution.kind === 'not_found') throw new CliError(notFoundMessage);
  if (resolution.kind === 'ambiguous_provider_reference') {
    throw new CliError(formatAmbiguousProviderReference(resolution));
  }
  return resolution;
}

// phase 1452 Step B: config mutation 子命令 saveGlobal 成功侧 CLI audit。
// phase 1879 Step D: audit 创建统一经 action scope（有 scope 同 dir 复用 + 统一 dispose；
// 无 scope 直调回落裸创建）；与 notifyRunningDaemons 同根（chestnutRoot）。
function configAudit(deps: ConfigCommandDeps): AuditLog {
  return actionAuditFor(getChestnutRoot(), deps);
}

// provider add command
async function selectSetupService(
  rl: readline.Interface,
): Promise<{ kind: 'setup'; choice: SetupProviderChoice } | { kind: 'advanced' }> {
  console.log('\nSelect service:');
  SETUP_PROVIDER_CATALOG.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label} — ${choice.description}`);
  });
  console.log(`  ${SETUP_PROVIDER_CATALOG.length + 1}. Advanced (all presets / catalog providers / custom endpoint)`);
  const raw = await question(rl, '\n> ');
  const num = parseInt(raw, 10);
  if (Number.isNaN(num)) throw new CliError('Invalid choice: not a number');
  const choice = SETUP_PROVIDER_CATALOG[num - 1];
  if (choice) return { kind: 'setup', choice };
  if (num === SETUP_PROVIDER_CATALOG.length + 1) return { kind: 'advanced' };
  throw new CliError('Invalid selection');
}

type ProviderAddService = Awaited<ReturnType<typeof selectSetupService>>;

type ProviderAddAuthProfile = 'api_key' | 'local' | 'oauth' | 'ambient';

interface ProviderAddDraft {
  service: ProviderAddService;
  presetId?: string;
  providerId?: string;
  serviceName: string;
  authProfile: ProviderAddAuthProfile;
  defaultModel?: string;
  defaultBaseUrl?: string;
  envVar?: string;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

async function promptProviderAddApiKey(
  deps: ConfigCommandDeps,
  rl: readline.Interface,
  input: Pick<ProviderAddDraft, 'authProfile' | 'envVar' | 'serviceName' | 'presetId'>,
  label: string,
  created: StoredCredential[],
  forceKeyPrompt: boolean = false,
): Promise<string | undefined> {
  const { authProfile, envVar, serviceName, presetId } = input;
  if (authProfile === 'local' && forceKeyPrompt) {
    console.log(`ℹ ${serviceName}: local provider, no API key required.`);
    return undefined;
  }
  if (authProfile === 'api_key' || forceKeyPrompt) {
    const envReady = Boolean(envVar && process.env[envVar]);
    // Phase 1984 Step B：提示同时说明两种行为——回车=读环境变量，输入=使用输入值。
    const rawKey = await passwordQuestion(rl, `${setupApiKeyPrompt(envReady ? envVar : undefined)}: `);
    if (!rawKey && envReady && envVar) {
      console.log(`✓ Will read from ${envVar} at runtime`);
      return '${' + envVar + '}';
    }
    if (!rawKey) throw new CliError('API Key is required');
    // env 同名已设置时，typed key 改用派生 ref 保存（不被 env 遮蔽）；派生 ref 仍被
    // 遮蔽则 loud 失败。env 未设置时保持 preset envVar ref。
    const storeCtx = envReady
      ? { seed: label, onShadowedEnv: 'error' as const }
      : { envVar, seed: label, onShadowedEnv: 'error' as const };
    return storeKeyAsCredential(deps, rawKey, storeCtx, {
      onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    });
  }
  if (authProfile === 'local') {
    console.log(`ℹ ${serviceName}: local provider, no API key required.`);
  } else if (presetId) {
    const preset = PRESETS[presetId];
    console.log(`\nℹ ${preset?.displayName ?? serviceName} 认证来源：${preset?.authHint ?? authProfile}`);
  } else {
    console.log(`\nℹ ${serviceName} 为 OAuth provider——配置后运行 "chestnut config provider login ${label}" 完成登录。`);
  }
  return undefined;
}

async function collectProviderAddDraft(
  deps: ConfigCommandDeps,
  rl: readline.Interface,
  config: LLMGlobalConfigView,
  created: StoredCredential[],
  preservedLabel?: string,
): Promise<ProviderAddDraft> {
  const service = await selectSetupService(rl);

  let presetId: string | undefined;
  let providerId: string | undefined;
  let serviceName: string;
  let authProfile: ProviderAddAuthProfile = 'api_key';
  let defaultModel: string | undefined;
  let defaultBaseUrl: string | undefined;
  let envVar: string | undefined;

  if (service.kind === 'setup') {
    const choice = service.choice;
    serviceName = choice.label;
    if (choice.auth === 'advanced') {
      SETUP_OTHER_FORMAT_LINES.forEach(line => console.log(line));
      const fmt = await question(rl, '> ', '2');
      presetId = FORMAT_MAP[fmt] ?? '';
      if (!presetId) throw new CliError('Invalid API format');
    } else {
      presetId = choice.target.preset;
      providerId = choice.target.providerId;
      const target = describeExplicitSetupTarget(choice.target);
      defaultModel = choice.defaultModel ?? target.defaultModel;
      defaultBaseUrl = target.defaultBaseUrl;
      envVar = choice.envVar ?? target.envVar;
      authProfile = choice.auth === 'local' ? 'local' : target.authProfile;
    }
  } else {
    const adv = await selectPreset(rl);
    const preset = adv.kind === 'preset' ? PRESETS[adv.id] : undefined;
    presetId = adv.kind === 'preset' ? adv.id : undefined;
    providerId = adv.kind === 'catalog' ? adv.id : undefined;
    serviceName = preset?.displayName ?? adv.id;
    const target = describeExplicitSetupTarget({
      ...(presetId !== undefined && { preset: presetId }),
      ...(providerId !== undefined && { providerId }),
    });
    defaultModel = target.defaultModel;
    defaultBaseUrl = target.defaultBaseUrl;
    envVar = target.envVar;
    authProfile = target.authProfile;
  }

  const defaultLabel = presetId ?? providerId ?? 'provider';
  const labelInput = preservedLabel ?? await question(rl, '\nLabel (press Enter to use service name)', defaultLabel);
  const label = labelInput || defaultLabel;

  if (providerLabelExists(config, label)) {
    throw new CliError(`A provider with label "${label}" already exists`);
  }

  const apiKey = await promptProviderAddApiKey(
    deps,
    rl,
    { authProfile, envVar, serviceName, presetId },
    label,
    created,
  );

  let baseUrl: string | undefined;
  if (presetId && explicitSetupTargetRequiresBaseUrl({ preset: presetId })) {
    baseUrl = await question(rl, 'Base URL');
    if (!baseUrl) throw new CliError('Base URL is required for this provider');
  }

  let model: string;
  if (providerId) {
    model = await question(rl, 'Model');
    if (!model) throw new CliError('Model is required for catalog providers');
  } else {
    model = await question(rl, 'Model', defaultModel || undefined);
    if (!model) throw new CliError('Model is required');
  }

  return {
    service,
    ...(presetId !== undefined && { presetId }),
    ...(providerId !== undefined && { providerId }),
    serviceName,
    authProfile,
    ...(defaultModel !== undefined && { defaultModel }),
    ...(defaultBaseUrl !== undefined && { defaultBaseUrl }),
    ...(envVar !== undefined && { envVar }),
    label,
    ...(apiKey !== undefined && { apiKey }),
    ...(baseUrl !== undefined && { baseUrl }),
    model,
  };
}

function providerAddSetupDraft(draft: ProviderAddDraft) {
  const probeCandidates =
    draft.service.kind === 'setup' ? draft.service.choice.probeCandidates : undefined;
  return makeExplicitSetupDraft({
    ...(draft.presetId !== undefined && { presetId: draft.presetId }),
    ...(draft.providerId !== undefined && { providerId: draft.providerId }),
    label: draft.label,
    ...(draft.apiKey !== undefined && { apiKey: draft.apiKey }),
    model: draft.model,
    ...(draft.baseUrl !== undefined && { baseUrl: draft.baseUrl }),
    defaultBaseUrl: draft.defaultBaseUrl,
    local: draft.authProfile === 'local',
  }, probeCandidates);
}

async function confirmProviderAddDraft(
  rl: readline.Interface,
  draft: ProviderAddDraft,
  role: 'primary' | 'fallback',
): Promise<boolean> {
  const custom =
    draft.service.kind === 'advanced' ||
    (draft.service.kind === 'setup' && isCustomSetupChoice(draft.service.choice));
  if (!custom) return true;
  const thinking = describeEffectiveThinking(draft.presetId, draft.model);
  setupDraftPreviewLines({
    label: draft.label,
    model: draft.model,
    auth: draft.authProfile === 'local' ? 'local' : draft.authProfile === 'api_key' ? 'API key' : draft.authProfile,
    role,
    ...(thinking !== undefined && { thinking }),
    ...(draft.baseUrl && { baseUrl: draft.baseUrl }),
    ...(draft.apiKey && { keyRef: draft.apiKey }),
  }).forEach(line => console.log(line));
  const confirm = await question(rl, `\n${SETUP_CONFIRM_PROMPT}`, 'Y');
  return confirm.toLowerCase() !== 'n';
}

async function providerAdd(deps: ConfigCommandDeps): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadGlobal();
  const rl = createRL();
  const created: StoredCredential[] = [];
  let commitAttempted = false;
  let committed = false;

  try {
    let draft = await collectProviderAddDraft(deps, rl, config, created);

    console.log('\nRole:');
    console.log('1. primary');
    console.log('2. fallback');
    const roleAnswer = await question(rl, '> ', '2');
    const role = roleAnswer === '1' ? 'primary' : 'fallback';

    let positionFromPrompt = 0;
    if (role === 'primary') {
      const currentPrimary = config.llm.primary;
      // Phase 1980 Step B：Primary 确认包含即将加入的 service/model。
      console.log(
        `\nAdd ${draft.serviceName} (${draft.model}) as primary? ` +
        `Current primary (${currentPrimary.label || currentPrimary.provider_id}) will become fallback #1.`,
      );
      const confirm = await question(rl, 'Confirm?', 'N');
      if (confirm.toLowerCase() !== 'y') {
        console.log(SETUP_CANCELLED);
        return;
      }
    } else {
      const currentFallbacks = config.llm.fallbacks ?? [];
      console.log(`\nCurrent fallbacks: ${currentFallbacks.length === 0 ? '(none)' : ''}`);
      currentFallbacks.forEach((f, i) => {
        console.log(`#${i + 1}: ${f.label || f.provider_id}`);
      });
      const posDefault = String(currentFallbacks.length + 1);
      const posStr = await question(rl, 'Position', posDefault);
      const position = parseInt(posStr, 10) - 1;
      if (Number.isNaN(position) || position < 0 || position > currentFallbacks.length) {
        throw new CliError(`Position must be 1-${currentFallbacks.length + 1}, got: ${posStr}`);
      }
      positionFromPrompt = position;
    }

    // Phase 1983 Step B：仅 Other/Advanced 自定义配置显示脱敏参数预览 + 确认
    // （与 start/init 同一谓词、同一文案）；普通服务（含自定义 model）不确认。
    // 顺序：Primary 降级确认（上方角色分支）→ 参数确认 → Connecting → probe。
    if (!(await confirmProviderAddDraft(rl, draft, role))) {
      console.log(SETUP_CANCELLED);
      return;
    }

    const probeCandidates =
      draft.service.kind === 'setup' ? draft.service.choice.probeCandidates : undefined;
    console.log(setupConnectingLine(draft.serviceName, draft.model));
    if (draft.baseUrl) console.log(`  Endpoint: ${draft.baseUrl}`);
    console.log('\nTesting connection...');
    if (probeCandidates !== undefined && probeCandidates.length > 0) {
      console.log(`Endpoint probes (model=${draft.model}):`);
    }

    const setupAudit = configAudit(deps);
    const outcome = await runLLMSetupWorkflow(
      {
        store: {
          commitExplicitProvider: async (target, explicitConfig, expectedRevision) => {
            // 提交结果可能因写后 snapshot/audit 异常而不可见；保守保留凭据，
            // 避免误删已绑定值（代价是拒绝提交时可能留下未使用条目）。
            commitAttempted = true;
            return deps.llmConfiguration.store.commitExplicitProvider(
              target, explicitConfig, expectedRevision,
            );
          },
        },
        probe: makeLLMSetupWorkflowProbe(deps, setupAudit),
        recheckIdentity: (draft, verified) => recheckLLMSetupIdentity(deps, draft, verified),
        emit: (event: LLMSetupWorkflowEvent) => {
          emitLLMSetupWorkflowAudit(setupAudit, event);
          if (event.type === 'probe_finished' && event.kind === 'candidate' && event.url !== undefined) {
            console.log(`→ ${event.url} ... ${event.result.ok ? '✓' : '✗'}`);
            if (event.winner) console.log(`Selected: ${event.url}`);
          }
        },
      },
      providerAddSetupDraft(draft),
      role === 'primary' ? { kind: 'primary' } : { kind: 'fallback', position: positionFromPrompt },
      async (attempt) => {
        if (attempt.candidates.some(candidate => candidate.kind === 'candidate')) {
          formatSetupProbeFailureLines(attempt.candidates.map(candidate => ({
            candidate: { presetId: '', baseUrl: candidate.url ?? '', label: candidate.identity },
            result: candidate.result.ok
              ? { ok: true as const, model: candidate.result.model }
              : {
                ok: false as const,
                errorType: candidate.result.errorType,
                message: candidate.result.message,
                provider: candidate.result.provider,
              },
          }))).forEach(line => console.log(line));
        } else {
          formatLLMError({
            errorType: attempt.failure.errorType,
            message: attempt.failure.message,
            provider: attempt.failure.provider,
            hint: LLM_ERROR_HINTS[attempt.failure.errorType],
          }).forEach(line => console.log(line));
          console.log(SETUP_PROBE_FAILED_NOT_SAVED);
        }
        const action = await promptRepairAction((prompt, defaultValue) => question(rl, prompt, defaultValue));
        if (action === 'cancel') return { kind: 'cancel', reason: 'user_cancelled' };
        if (action === 'retry') return { kind: 'retry' };
        if (action === 'edit-provider') {
          const next = await collectProviderAddDraft(deps, rl, config, created, draft.label);
          if (!(await confirmProviderAddDraft(rl, next, role))) {
            return { kind: 'cancel', reason: 'user_cancelled' };
          }
          draft = next;
        } else if (action === 'edit-key') {
          const apiKey = await promptProviderAddApiKey(deps, rl, draft, draft.label, created, true);
          draft = { ...draft, ...(apiKey !== undefined && { apiKey }) };
        } else {
          const model = await question(rl, 'Model', draft.defaultModel || undefined);
          if (!model) throw new CliError('Model is required');
          draft = { ...draft, model };
        }
        if (draft.service.kind === 'setup' && draft.service.choice.probeCandidates !== undefined) {
          draft = { ...draft, baseUrl: undefined };
        }
        return { kind: 'repair', draft: providerAddSetupDraft(draft) };
      },
      config.revision?.revision,
    );
    if (outcome.kind === 'cancelled') {
      console.log(SETUP_CANCELLED);
      return;
    }
    if (outcome.kind === 'concurrent') throw new Error('Unexpected initialize race during provider add');
    committed = true;

    reportDegradedConfigWrite('LLM global config', outcome.commit.write);
    if (role === 'primary') console.log(`\n✓ Provider "${draft.label}" is now primary`);
    else console.log(`\n✓ Provider "${draft.label}" added as fallback`);
    setupAudit.write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_add', `label=${draft.label}`, `role=${role}`);
    await notifyRunningDaemons(deps, 'add', outcome.commit.revision);
    console.log(`✓ ${outcome.verified.model}`);

  } finally {
    if (!committed && !commitAttempted) await discardCreatedCredentials(deps, created);
    rl.close();
  }
}

function formatApiKeyStatus(apiKey: unknown, deps: ConfigCommandDeps): string {
  const classified = classifyApiKeyConfigValue(apiKey);
  if (classified.kind === 'missing') return '-';
  if (classified.kind === 'legacy-plaintext') return 'legacy-unmigrated';
  if (classified.kind === 'invalid-reference') return 'invalid-ref';
  const authentication = createAuthenticationCapability({ fsFactory: deps.fsFactory });
  return authentication.describe(classified.ref).configured
    ? `ref=${classified.ref}`
    : `ref=${classified.ref}/missing`;
}

// provider list command
async function providerList(deps: ConfigCommandDeps): Promise<void> {
  // List is read-only: show legacy-unmigrated without resolving or exposing secrets.
  await deps.rootConfig.migrateLLMConfiguration();
  const config = deps.llmConfiguration.store.read();

  const primary = config.primary;
  const fallbacks = config.fallbacks ?? [];

  const terminalWidth = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
  const fixedColWidth = 82; // "  PRIMARY   " + padEnd(10,15,18,24) + 4 spaces
  const urlWidth = Math.max(10, terminalWidth - fixedColWidth);

  // Header
  console.log();
  console.log(`  ${'ROLE'.padEnd(10)} ${'PROVIDER'.padEnd(10)} ${'LABEL'.padEnd(15)} ${'MODEL'.padEnd(18)} ${'API_KEY'.padEnd(24)} ${'BASE_URL'}`);

  // Primary
  const pLabel = primary.label || '(no label)';
  const pBaseUrl = primary.base_url || '-';
  const pApiKey = formatApiKeyStatus(primary.api_key, deps);
  console.log(`  ${'PRIMARY'.padEnd(10)} ${primary.provider_id.padEnd(10)} ${pLabel.padEnd(15)} ${primary.model.padEnd(18)} ${pApiKey.padEnd(24)} ${fitLine(pBaseUrl, urlWidth)}`);

  // Fallbacks
  fallbacks.forEach((f, i) => {
    const fLabel = f.label || '(no label)';
    const fBaseUrl = f.base_url || '-';
    const fApiKey = formatApiKeyStatus(f.api_key, deps);
    const rowLabel = `#${i + 1}`;
    console.log(`  ${rowLabel.padEnd(10)} ${f.provider_id.padEnd(10)} ${fLabel.padEnd(15)} ${f.model.padEnd(18)} ${fApiKey.padEnd(24)} ${fitLine(fBaseUrl, urlWidth)}`);
  });

  console.log();
}

// provider remove command
async function providerRemove(deps: ConfigCommandDeps, label: string): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadGlobal();
  
  const found = requireProviderReference(config, label);
  if (found.candidate.role === 'primary') {
    throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
  }

  let actualTarget = found;
  // Phase 1910 Step D：锁内对新鲜配置重放（快照只用于预检）
  const write = await deps.llmConfiguration.mutateGlobalLocked((fresh) => {
    const freshFound = requireProviderReference(fresh, label);
    if (freshFound.candidate.role === 'primary') {
      throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
    }
    actualTarget = freshFound;
    fresh.llm.fallbacks!.splice(freshFound.candidate.index, 1);
  });
  reportDegradedConfigWrite('LLM global config', write);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_remove',
    `label=${actualTarget.candidate.label || '(no label)'}`,
    `role=${actualTarget.candidate.role}`,
    `match=${actualTarget.matchedBy}`,
  );
  console.log(`✓ Removed provider (${formatProviderTarget(actualTarget)}) from fallbacks`);
  await notifyRunningDaemons(deps, 'remove');
}

// provider set-primary command
async function providerSetPrimary(deps: ConfigCommandDeps, label: string): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadGlobal();
  
  const found = requireProviderReference(config, label);
  if (found.candidate.role === 'primary') {
    console.log(`Provider (${formatProviderTarget(found)}) is already primary`);
    return;
  }
  
  const currentPrimary = config.llm.primary;

  console.log(`\nCurrent primary (${currentPrimary.label || '(no label)'}) will become fallback #1.`);
  const rl = createRL();
  const confirm = await question(rl, 'Confirm?', 'N');
  rl.close();

  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled');
    return;
  }

  let actualTarget = found;
  // Phase 1910 Step D：锁内对新鲜配置重放（快照只用于确认提示）
  const write = await deps.llmConfiguration.mutateGlobalLocked((fresh) => {
    const freshFound = requireProviderReference(fresh, label);
    if (freshFound.candidate.role === 'primary') {
      throw new CliError(`Provider (${formatProviderTarget(freshFound)}) is already primary`);
    }
    actualTarget = freshFound;
    const freshPrimary = fresh.llm.primary;
    const target = fresh.llm.fallbacks![freshFound.candidate.index];
    fresh.llm.fallbacks!.splice(freshFound.candidate.index, 1);
    fresh.llm.fallbacks!.unshift(freshPrimary);
    fresh.llm.primary = target;
  });
  reportDegradedConfigWrite('LLM global config', write);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_set_primary',
    `label=${actualTarget.candidate.label || '(no label)'}`,
    `role=${actualTarget.candidate.role}`,
    `match=${actualTarget.matchedBy}`,
  );
  console.log(`✓ Provider (${formatProviderTarget(actualTarget)}) is now primary`);
  await notifyRunningDaemons(deps, 'set-primary');

  // phase 451: 改 primary 必 probe
  console.log('\nTesting new primary connection...');
  const probe = await checkLLMConnection(deps);
  if (probe.ok) {
    console.log(`✓ ${probe.model}`);
  } else {
    formatLLMError({
      errorType: probe.errorType,
      message: probe.message,
      provider: probe.provider,
      hint: LLM_ERROR_HINTS[probe.errorType],
    }).forEach(line => console.log(line));
    if (probe.errorType === 'auth' || probe.errorType === 'model') {
      const rlProbe = createRL();
      try {
        await promptReconfigure(deps, rlProbe, probe.errorType);
      } finally {
        rlProbe.close();
      }
    }
  }
}

// provider move command
async function providerMove(deps: ConfigCommandDeps, label: string, position: string): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadGlobal();
  
  const found = requireProviderReference(config, label);
  if (found.candidate.role === 'primary') {
    throw new CliError('Cannot move primary provider');
  }
  
  const newPos = parseInt(position, 10) - 1;
  const fallbacks = config.llm.fallbacks!;

  if (Number.isNaN(newPos) || newPos < 0 || newPos >= fallbacks.length) {
    throw new CliError(`Invalid position. Must be 1-${fallbacks.length}, got: ${position}`);
  }

  let actualTarget = found;
  // Phase 1910 Step D：锁内对新鲜配置重放（快照只用于预检）
  const write = await deps.llmConfiguration.mutateGlobalLocked((fresh) => {
    const freshFound = requireProviderReference(fresh, label);
    if (freshFound.candidate.role === 'primary') {
      throw new CliError('Cannot move primary provider');
    }
    actualTarget = freshFound;
    const freshFallbacks = fresh.llm.fallbacks!;
    const clampedPos = Math.min(newPos, freshFallbacks.length - 1);
    const [removed] = freshFallbacks.splice(freshFound.candidate.index, 1);
    freshFallbacks.splice(clampedPos, 0, removed);
  });
  reportDegradedConfigWrite('LLM global config', write);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_move',
    `label=${actualTarget.candidate.label || '(no label)'}`,
    `role=${actualTarget.candidate.role}`,
    `match=${actualTarget.matchedBy}`,
    `position=${newPos + 1}`,
  );
  console.log(`✓ Provider (${formatProviderTarget(actualTarget)}) moved to fallback #${newPos + 1}`);
  await notifyRunningDaemons(deps, 'move');
}

/**
 * Phase 1926 Step D：provider 登录/登出（pi-ai 原生 login 流）。
 * label → config 里的 provider（primary/fallback）→ preset.piAiProvider；
 * --type 缺省取 provider 首选（oauth 优先，其次 api_key 交互登录）。
 * loadGlobal 先执行（Credentials owner backend 注册同点，见 config-load.ts）。
 */
async function providerLogin(deps: ConfigCommandDeps, label: string, opts: { type?: string }): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadGlobal();
  const hit = requireProviderReference(
    config,
    label,
    `Provider "${label}" not found (check "chestnut config provider list")`,
  );
  const entry = providerEntryFor(config, hit.candidate);
  const piAiProvider = entry.provider_id?.startsWith('custom:') ? undefined : entry.provider_id;
  const preset = Object.values(PRESETS).find(candidate => candidate.piAiProvider === piAiProvider);
  if (!piAiProvider) {
    throw new CliError(
      `Provider "${label}" has no pi-ai catalog provider; ` +
      `login is only available for catalog providers (api key goes to "config provider add" / reconfigure)`,
    );
  }
  let type: ProviderLoginType | undefined;
  if (opts.type !== undefined) {
    if (opts.type === 'oauth' || opts.type === 'api-key' || opts.type === 'api_key') {
      type = opts.type === 'oauth' ? 'oauth' : 'api_key';
    } else {
      throw new CliError(`Invalid --type "${opts.type}" (expected: oauth | api-key)`);
    }
  }
  const available = await providerLoginTypes(piAiProvider);
  if (available.length === 0) {
    throw new CliError(
      `Provider "${piAiProvider}" has no interactive login (ambient-only: ${preset?.authHint ?? 'configure environment'})`,
    );
  }
  type ??= available[0];
  if (!available.includes(type)) {
    throw new CliError(`Provider "${piAiProvider}" does not support ${type} login (available: ${available.join(', ')})`);
  }
  await runProviderLogin({
    piAiProvider,
    type,
    authentication: createAuthenticationSetup({ fsFactory: deps.fsFactory }),
  });
  console.log(`✓ Provider (${formatProviderTarget(hit)}) logged in`);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_login',
    `label=${hit.candidate.label || '(no label)'}`,
    `role=${hit.candidate.role}`,
    `match=${hit.matchedBy}`,
    `type=${type}`,
  );
  await notifyRunningDaemons(deps, 'login');
}

async function providerLogout(deps: ConfigCommandDeps, label: string): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadGlobal();
  const hit = requireProviderReference(
    config,
    label,
    `Provider "${label}" not found (check "chestnut config provider list")`,
  );
  const entry = providerEntryFor(config, hit.candidate);
  const piAiProvider = entry.provider_id?.startsWith('custom:') ? undefined : entry.provider_id;
  if (!piAiProvider) {
    throw new CliError(`Provider "${label}" has no pi-ai catalog provider; no stored credential to remove`);
  }
  await runProviderLogout({
    piAiProvider,
    authentication: createAuthenticationSetup({ fsFactory: deps.fsFactory }),
  });
  console.log(`✓ Provider (${formatProviderTarget(hit)}) logged out`);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_logout',
    `label=${hit.candidate.label || '(no label)'}`,
    `role=${hit.candidate.role}`,
    `match=${hit.matchedBy}`,
  );
  await notifyRunningDaemons(deps, 'logout');
}

// Build the config command
interface ConfigCommandDeps {
  fsFactory: (baseDir: string) => FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'migrateLLMConfiguration'>;
  llmConfiguration: Pick<
    LLMConfigurationAdmin,
    'loadGlobal' | 'mutateGlobalLocked' | 'patchPrimary' | 'readRevision' |
    'migrateLegacyApiKeys' | 'store'
  >;
}

// phase 1874 Step L（族 3b）: 形状经 CLIProtocol catalog 投影
function configSpec(id: string): CommandShapeSpec {
  const spec = getConfigCommandSpec(id);
  if (!spec) throw new Error(`unknown config command id in catalog: ${id}`);
  return spec;
}

export function createConfigCommand(deps: ConfigCommandDeps): Command {
  // phase 1874 Step L（族 3b）: 命令形状经 CLIProtocol catalog 投影
  const configCommand = shapeCommand(new Command('config'), configSpec('config'));

  function action<TArgs extends unknown[]>(
    policy: SupervisionPolicy,
    handler: (...args: TArgs) => Promise<void>,
  ): (...args: TArgs) => Promise<void> {
    return cliAction(policy, async (...args: TArgs) => {
      await handler(...args);
    }, { fsFactory: deps.fsFactory });
  }

  // provider subcommand
  const providerCmd = shapeCommand(new Command('provider'), configSpec('config/provider'));

  shapeCommand(providerCmd.command('add'), configSpec('config/provider/add'))
    .action(action('required', () => providerAdd(deps)));

  shapeCommand(providerCmd.command('list'), configSpec('config/provider/list'))
    .action(action('observe_only', () => providerList(deps)));

  shapeCommand(providerCmd.command('remove <label>'), configSpec('config/provider/remove'))
    .action(action('required', (label: string) => providerRemove(deps, label)));

  shapeCommand(providerCmd.command('set-primary <label>'), configSpec('config/provider/set-primary'))
    .action(action('required', (label: string) => providerSetPrimary(deps, label)));

  shapeCommand(providerCmd.command('move <label> <position>'), configSpec('config/provider/move'))
    .action(action('required', (label: string, position: string) => providerMove(deps, label, position)));

  shapeCommand(providerCmd.command('login <label>'), configSpec('config/provider/login'))
    .action(action('required', (label: string, opts: { type?: string }) => providerLogin(deps, label, opts)));

  shapeCommand(providerCmd.command('logout <label>'), configSpec('config/provider/logout'))
    .action(action('required', (label: string) => providerLogout(deps, label)));

  configCommand.addCommand(providerCmd);
  return configCommand;
}
