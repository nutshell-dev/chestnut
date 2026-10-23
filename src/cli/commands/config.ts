/**
 * config command - Manage LLM provider configuration
 */

import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import type { ClawGlobalConfig } from '../../assembly/index.js';
import { createUserPiAiCredentialStore } from '../../assembly/index.js';
import type { LLMProviderConfig } from '../../foundation/llm-orchestrator/index.js';
import { PRESETS, presetAuthProfile, presetRequiresBaseUrl } from '../../foundation/llm-provider/index.js';
// Phase 1927 Step D：catalog-only provider 选择与派生 profile（显式 catalog 配置入口）
import { catalogProvidersWithoutPreset, deriveCatalogAuthProfile } from '../../foundation/llm-provider/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { CliError } from '../errors.js';
// phase 1874 Step B: 终端文本原语经 viewport 模块 barrel（CLIProtocol 有 zod-only bare 白名单、不容 string-width）
import { fitLine } from '../../viewport/index.js';
import { cliAction, type SupervisionPolicy } from '../supervision-policy.js';
import { DEFAULT_TERMINAL_WIDTH } from '../../viewport/index.js';
import { DEFAULT_LLM_TIMEOUT_MS, FORMAT_MAP } from '../../foundation/llm-orchestrator/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { RootConfigAdmin } from '../../assembly/index.js';
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
  SETUP_PROBE_FAILED_NOT_SAVED,
  setupDraftPreviewLines,
} from '../../templates/messages/index.js';
import { toProviderConfig } from '../../foundation/llm-orchestrator/index.js';
import { checkLLMConnection, checkLLMConnectionFor, promptReconfigure, formatLLMError, LLM_ERROR_HINTS } from '../llm-connection-check.js';
// Phase 1925 Step B：明文 key 不落 root config —— 经 Credentials owner 落用户级凭据文件、配置写 `${REF}`。
import { storeKeyAsCredential, resolveCredentialReference } from '../credentials-prompt.js';
import { SETUP_PROVIDER_CATALOG, describeEffectiveThinking, type SetupProviderChoice, type SetupProbeCandidate } from '../setup-provider-catalog.js';
import { makeSetupCandidateProbe, probeSetupCandidates } from '../setup-provider-probe.js';
import { passwordQuestion } from '../utils/password-prompt.js';
import { shapeCommand, getConfigCommandSpec, type CommandShapeSpec } from '../../cli-protocol/index.js';
// Phase 1926 Step D：provider login/logout 运行缝（pi-ai 原生 login 流 + Credentials owner 持久化）
import { runProviderLogin, runProviderLogout, providerLoginTypes, type ProviderLoginType } from '../llm-login.js';

/**
 * phase 320: 通知所有运行中的 daemon（motion + 所有 claws）重新加载 LLM 配置。
 * Producer 侧 / consumer 侧在 Runtime._drainOwnInbox 拦截路径。
 *
 * - daemon 不存活 → silent skip（下次启动自然读新配置）
 * - notifyClaw 失败 silent（按现有 messaging 语义、不阻 CLI）
 */
export function notifyRunningDaemons(deps: { fsFactory: (baseDir: string) => FileSystem }, source: string): void {
  const chestnutRoot = getChestnutRoot();
  const pm = createProcessManagerForCLI({ ...deps, baseDir: chestnutRoot });
  const rootFs = deps.fsFactory(chestnutRoot);
  const audit = actionAuditFor(chestnutRoot, deps);

  const candidates: string[] = [MOTION_CLAW_ID];
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);
  if (rootFs.existsSync(clawsDir)) {
    const subFs = deps.fsFactory(clawsDir);
    candidates.push(...enumerateClaws(subFs, '.'));
  }

  let notified = 0;
  // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
  const clawNotifier = createClawNotifier({
    fs: rootFs,
    audit,
    resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
  });
  for (const id of candidates) {
    const clawId = id === MOTION_CLAW_ID ? MOTION_CLAW_ID : makeClawId(id);
    if (!pm.isAlive(resolveClawDaemonDir(clawId))) continue;
    clawNotifier.notify(id, {
      type: RELOAD_LLM_CONFIG_MESSAGE_TYPE,
      // source must not contain '/'; it goes into the inbox file name
      source: `cli-${source}`,
      priority: 'high',
      // phase 1909 Step B（M14）：正文呈现归 templates/messages 单源
      body: CONFIG_RELOAD_NOTICE,
    });
    notified++;
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

// Promise wrapper for rl.question
function question(rl: readline.Interface, prompt: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const fullPrompt = defaultValue !== undefined
      ? `${prompt} [${defaultValue}]: `
      : `${prompt}: `;
    rl.question(fullPrompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
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

// Find provider by label in config
function findProviderIndex(config: ClawGlobalConfig, label: string): { type: 'primary' | 'fallback'; index: number } | null {
  if (config.llm.primary.label === label || config.llm.primary.preset === label || config.llm.primary.provider_id === label) {
    return { type: 'primary', index: -1 };
  }
  const fbIndex = (config.llm.fallbacks ?? []).findIndex(
    f => f.label === label || f.preset === label || f.provider_id === label
  );
  if (fbIndex !== -1) {
    return { type: 'fallback', index: fbIndex };
  }
  return null;
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

async function providerAdd(deps: ConfigCommandDeps): Promise<void> {
  const config = deps.rootConfig.loadGlobal();
  const rl = createRL();

  try {
    const service = await selectSetupService(rl);

    let presetId: string | undefined;
    let providerId: string | undefined;
    let serviceName: string;
    let authProfile: 'api_key' | 'local' | 'oauth' | 'ambient' = 'api_key';
    let defaultModel: string | undefined;
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
        const preset = presetId ? PRESETS[presetId] : undefined;
        if (!preset) throw new CliError(`Internal provider mapping missing for ${choice.label}`);
        defaultModel = choice.defaultModel ?? preset.defaultModel;
        envVar = choice.envVar ?? preset.envVar;
        authProfile = choice.auth === 'local' ? 'local' : (presetAuthProfile(preset) as typeof authProfile);
      }
    } else {
      const adv = await selectPreset(rl);
      const preset = adv.kind === 'preset' ? PRESETS[adv.id] : undefined;
      presetId = adv.kind === 'preset' ? adv.id : undefined;
      providerId = adv.kind === 'catalog' ? adv.id : undefined;
      serviceName = preset?.displayName ?? adv.id;
      defaultModel = preset?.defaultModel;
      envVar = preset?.envVar;
      authProfile = preset
        ? (presetAuthProfile(preset) as typeof authProfile)
        : (deriveCatalogAuthProfile(adv.id) === 'oauth' ? 'oauth' : 'api_key');
    }

    const defaultLabel = presetId ?? providerId ?? 'provider';
    const labelInput = await question(rl, '\nLabel (press Enter to use service name)', defaultLabel);
    const label = labelInput || defaultLabel;

    if (findProviderIndex(config, label)) {
      throw new CliError(`A provider with label "${label}" already exists`);
    }

    let apiKey: string | undefined;
    if (authProfile === 'api_key') {
      const envReady = Boolean(envVar && process.env[envVar]);
      const hint = envReady ? ` (press Enter to use ${envVar})` : '';
      const rawKey = await passwordQuestion(rl, `API Key${hint}: `);
      if (!rawKey && envReady && envVar) {
        apiKey = '${' + envVar + '}';
        console.log(`✓ Will read from ${envVar} at runtime`);
      } else if (!rawKey) {
        throw new CliError('API Key is required');
      } else {
        apiKey = await storeKeyAsCredential(deps, rawKey, { envVar, seed: label });
      }
    } else if (authProfile === 'local') {
      console.log(`ℹ ${serviceName}: local provider, no API key required.`);
    } else if (presetId) {
      const preset = PRESETS[presetId];
      console.log(`\nℹ ${preset?.displayName ?? serviceName} 认证来源：${preset?.authHint ?? authProfile}`);
    } else {
      console.log(`\nℹ ${serviceName} 为 OAuth provider——配置后运行 "chestnut config provider login ${label}" 完成登录。`);
    }

    let baseUrl: string | undefined;
    if (presetId && PRESETS[presetId] && presetRequiresBaseUrl(PRESETS[presetId])) {
      baseUrl = await question(rl, 'Base URL');
      if (!baseUrl) throw new CliError('Base URL is required for this provider');
    }

    let model: string;
    if (providerId) {
      model = await question(rl, 'Model');
      if (!model) throw new CliError('Model is required for catalog providers');
    } else {
      model = await question(
        rl,
        `Model${defaultModel ? ` (default: ${defaultModel})` : ''}`,
        defaultModel ?? '',
      );
      if (!model) throw new CliError('Model is required');
    }

    console.log('\nRole:');
    console.log('1. primary');
    console.log('2. fallback');
    const roleAnswer = await question(rl, '> ', '2');
    const role = roleAnswer === '1' ? 'primary' : 'fallback';

    const providerConfig: LLMProviderConfig = {
      ...(providerId ? { provider_id: providerId } : { preset: presetId }),
      label,
      ...(apiKey !== undefined && { api_key: apiKey }),
      model,
      temperature: 0.7,
      timeout_ms: DEFAULT_LLM_TIMEOUT_MS,
    };
    if (baseUrl) {
      providerConfig.base_url = baseUrl;
    }

    let positionFromPrompt = 0;
    if (role === 'primary') {
      const currentPrimary = config.llm.primary;
      console.log(`\nCurrent primary (${currentPrimary.label || currentPrimary.preset || currentPrimary.provider_id}) will become fallback #1.`);
      const confirm = await question(rl, 'Confirm? [y/N]', 'N');
      if (confirm.toLowerCase() !== 'y') {
        console.log(SETUP_CANCELLED);
        return;
      }
    } else {
      const currentFallbacks = config.llm.fallbacks ?? [];
      console.log(`\nCurrent fallbacks: ${currentFallbacks.length === 0 ? '(none)' : ''}`);
      currentFallbacks.forEach((f, i) => {
        console.log(`#${i + 1}: ${f.label || f.preset}`);
      });
      const posDefault = String(currentFallbacks.length + 1);
      const posStr = await question(rl, 'Position', posDefault);
      const position = parseInt(posStr, 10) - 1;
      if (Number.isNaN(position) || position < 0 || position > currentFallbacks.length) {
        throw new CliError(`Position must be 1-${currentFallbacks.length + 1}, got: ${posStr}`);
      }
      positionFromPrompt = position;
    }

    // Phase 1972: redacted preview before probe/commit (never includes the secret).
    const probeCandidates =
      service.kind === 'setup' ? service.choice.probeCandidates : undefined;
    setupDraftPreviewLines({
      label,
      model,
      auth: authProfile === 'local' ? 'local' : authProfile === 'api_key' ? 'API key' : authProfile,
      role,
      // Phase 1979: preset 默认 thinking（custom/Other 显示；固定服务由 helper 决定）
      ...(describeEffectiveThinking(presetId, model) !== undefined && {
        thinking: describeEffectiveThinking(presetId, model),
      }),
      ...(baseUrl && { baseUrl }),
      ...(apiKey && { keyRef: apiKey }),
    }).forEach(line => console.log(line));
    // Phase 1973 Step C：多端点候选的服务预览显式标注 auto-probe（不含 secret）。
    if (probeCandidates && probeCandidates.length > 0) {
      console.log(`  Endpoint: auto-probe (${probeCandidates.length})`);
    }

    const saveAnswer = await question(rl, 'Save this provider? [Y/n]', 'Y');
    if (saveAnswer.toLowerCase() === 'n') {
      console.log(SETUP_CANCELLED);
      return;
    }

    // Phase 1972: probe before commit. Unverified providers are not persisted.
    console.log('\nTesting connection...');
    let verifiedModel: string;
    if (probeCandidates && probeCandidates.length > 0) {
      // Phase 1973 Step C：按候选顺序 probe，首胜者 baseUrl 落盘；全败不 commit。
      console.log(`Endpoint probes (model=${model}):`);
      const candidateProbe = makeSetupCandidateProbe(
        { label, ...(apiKey !== undefined && { apiKey }), model },
        {
          resolveKey: (ref) => resolveCredentialReference(deps, ref),
          credentials: createUserPiAiCredentialStore({ fsFactory: deps.fsFactory }),
        },
      );
      const outcome = await probeSetupCandidates(probeCandidates, async (candidate: SetupProbeCandidate) => {
        const result = await candidateProbe(candidate);
        console.log(`→ ${candidate.label} ... ${result.ok ? '✓' : `✗ ${result.errorType}`}`);
        return result;
      });
      if (!outcome.winner) {
        for (const attempt of outcome.attempts) {
          if (attempt.result.ok) continue;
          formatLLMError({
            errorType: attempt.result.errorType,
            message: attempt.result.message,
            provider: attempt.result.provider,
            hint: LLM_ERROR_HINTS[attempt.result.errorType],
          }).forEach(line => console.log(line));
        }
        console.log(SETUP_PROBE_FAILED_NOT_SAVED);
        return;
      }
      providerConfig.base_url = outcome.winner.baseUrl;
      console.log(`Selected: ${outcome.winner.label} — ${outcome.winner.baseUrl}`);
      verifiedModel = outcome.winnerModel ?? model;
    } else {
      const providerConfigRuntime = toProviderConfig(providerConfig);
      if (providerConfigRuntime.apiKey !== undefined) {
        const resolvedKey = resolveCredentialReference(deps, providerConfigRuntime.apiKey);
        if (resolvedKey === undefined) {
          throw new CliError(
            `API key reference ${providerConfig.api_key} could not be resolved ` +
            `(not in process env, credentials file, or .env fallbacks)`,
          );
        }
        providerConfigRuntime.apiKey = resolvedKey;
      }
      const probe = await checkLLMConnectionFor(providerConfigRuntime, {
        credentials: createUserPiAiCredentialStore({ fsFactory: deps.fsFactory }),
      });
      if (!probe.ok) {
        formatLLMError({
          errorType: probe.errorType,
          message: probe.message,
          provider: probe.provider,
          hint: LLM_ERROR_HINTS[probe.errorType],
        }).forEach(line => console.log(line));
        console.log(SETUP_PROBE_FAILED_NOT_SAVED);
        return;
      }
      verifiedModel = probe.model;
    }

    await deps.rootConfig.mutateGlobalLocked((fresh) => {
      if (findProviderIndex(fresh, label)) {
        throw new CliError(`A provider with label "${label}" already exists`);
      }
      if (role === 'primary') {
        const currentPrimary = fresh.llm.primary;
        fresh.llm.fallbacks = [currentPrimary, ...(fresh.llm.fallbacks ?? [])];
        fresh.llm.primary = providerConfig;
      } else {
        const currentFallbacks = [...(fresh.llm.fallbacks ?? [])];
        const position = Math.min(positionFromPrompt, currentFallbacks.length);
        currentFallbacks.splice(position, 0, providerConfig);
        fresh.llm.fallbacks = currentFallbacks;
      }
    });
    if (role === 'primary') {
      console.log(`\n✓ Provider "${label}" is now primary`);
    } else {
      console.log(`\n✓ Provider "${label}" added as fallback`);
    }
    configAudit(deps).write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_add', `label=${label}`, `role=${role}`);
    notifyRunningDaemons(deps, 'add');
    console.log(`✓ ${verifiedModel}`);

  } finally {
    rl.close();
  }
}

function formatApiKey(apiKey: string): string {
  if (!apiKey) return '-';
  if (/^\$\{[A-Z_]+\}$/.test(apiKey)) return apiKey;
  if (apiKey.length <= 8) return apiKey.slice(0, 2) + '..' + apiKey.slice(-2);
  return apiKey.slice(0, 4) + '...' + apiKey.slice(-4);
}

// provider list command
async function providerList(deps: ConfigCommandDeps): Promise<void> {
  const config = deps.rootConfig.loadGlobal();

  const primary = config.llm.primary;
  const fallbacks = config.llm.fallbacks ?? [];

  const terminalWidth = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
  const fixedColWidth = 82; // "  PRIMARY   " + padEnd(10,15,18,24) + 4 spaces
  const urlWidth = Math.max(10, terminalWidth - fixedColWidth);

  // Header
  console.log();
  console.log(`  ${'ROLE'.padEnd(10)} ${'PRESET'.padEnd(10)} ${'LABEL'.padEnd(15)} ${'MODEL'.padEnd(18)} ${'API_KEY'.padEnd(24)} ${'BASE_URL'}`);

  // Primary
  const pPreset = primary.preset ?? '';
  const pLabel = primary.label || pPreset || '(unknown)';
  const pModel = primary.model || PRESETS[pPreset]?.defaultModel || 'unknown';
  const pBaseUrl = primary.base_url || PRESETS[pPreset]?.defaultBaseUrl || '-';
  const pApiKey = formatApiKey(primary.api_key ?? '');
  console.log(`  ${'PRIMARY'.padEnd(10)} ${pPreset.padEnd(10)} ${pLabel.padEnd(15)} ${pModel.padEnd(18)} ${pApiKey.padEnd(24)} ${fitLine(pBaseUrl, urlWidth)}`);

  // Fallbacks
  fallbacks.forEach((f, i) => {
    const fPreset = f.preset ?? '';
    const fLabel = f.label || fPreset || '(unknown)';
    const fModel = f.model || PRESETS[fPreset]?.defaultModel || 'unknown';
    const fBaseUrl = f.base_url || PRESETS[fPreset]?.defaultBaseUrl || '-';
    const fApiKey = formatApiKey(f.api_key ?? '');
    const rowLabel = `#${i + 1}`;
    console.log(`  ${rowLabel.padEnd(10)} ${fPreset.padEnd(10)} ${fLabel.padEnd(15)} ${fModel.padEnd(18)} ${fApiKey.padEnd(24)} ${fitLine(fBaseUrl, urlWidth)}`);
  });

  console.log();
}

// provider remove command
async function providerRemove(deps: ConfigCommandDeps, label: string): Promise<void> {
  const config = deps.rootConfig.loadGlobal();
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
  }

  // Phase 1910 Step D：锁内对新鲜配置重放（快照只用于预检）
  await deps.rootConfig.mutateGlobalLocked((fresh) => {
    const freshFound = findProviderIndex(fresh, label);
    if (!freshFound) {
      throw new CliError(`Provider "${label}" not found`);
    }
    if (freshFound.type === 'primary') {
      throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
    }
    fresh.llm.fallbacks!.splice(freshFound.index, 1);
  });
  configAudit(deps).write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_remove', `label=${label}`);
  console.log(`✓ Removed "${label}" from fallbacks`);
  notifyRunningDaemons(deps, 'remove');
}

// provider set-primary command
async function providerSetPrimary(deps: ConfigCommandDeps, label: string): Promise<void> {
  const config = deps.rootConfig.loadGlobal();
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    console.log(`"${label}" is already primary`);
    return;
  }
  
  const currentPrimary = config.llm.primary;

  console.log(`\nCurrent primary (${currentPrimary.label || currentPrimary.preset}) will become fallback #1.`);
  const rl = createRL();
  const confirm = await question(rl, 'Confirm? [y/N]', 'N');
  rl.close();

  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled');
    return;
  }

  // Phase 1910 Step D：锁内对新鲜配置重放（快照只用于确认提示）
  await deps.rootConfig.mutateGlobalLocked((fresh) => {
    const freshFound = findProviderIndex(fresh, label);
    if (!freshFound) {
      throw new CliError(`Provider "${label}" not found`);
    }
    if (freshFound.type === 'primary') {
      throw new CliError(`"${label}" is already primary`);
    }
    const freshPrimary = fresh.llm.primary;
    const target = fresh.llm.fallbacks![freshFound.index];
    fresh.llm.fallbacks!.splice(freshFound.index, 1);
    fresh.llm.fallbacks!.unshift(freshPrimary);
    fresh.llm.primary = target;
  });
  configAudit(deps).write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_set_primary', `label=${label}`);
  console.log(`✓ "${label}" is now primary`);
  notifyRunningDaemons(deps, 'set-primary');

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
  const config = deps.rootConfig.loadGlobal();
  
  const found = findProviderIndex(config, label);
  if (!found) {
    throw new CliError(`Provider "${label}" not found`);
  }
  
  if (found.type === 'primary') {
    throw new CliError('Cannot move primary provider');
  }
  
  const newPos = parseInt(position, 10) - 1;
  const fallbacks = config.llm.fallbacks!;

  if (Number.isNaN(newPos) || newPos < 0 || newPos >= fallbacks.length) {
    throw new CliError(`Invalid position. Must be 1-${fallbacks.length}, got: ${position}`);
  }

  // Phase 1910 Step D：锁内对新鲜配置重放（快照只用于预检）
  await deps.rootConfig.mutateGlobalLocked((fresh) => {
    const freshFound = findProviderIndex(fresh, label);
    if (!freshFound) {
      throw new CliError(`Provider "${label}" not found`);
    }
    if (freshFound.type === 'primary') {
      throw new CliError('Cannot move primary provider');
    }
    const freshFallbacks = fresh.llm.fallbacks!;
    const clampedPos = Math.min(newPos, freshFallbacks.length - 1);
    const [removed] = freshFallbacks.splice(freshFound.index, 1);
    freshFallbacks.splice(clampedPos, 0, removed);
  });
  configAudit(deps).write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_move', `label=${label}`, `position=${newPos + 1}`);
  console.log(`✓ "${label}" moved to fallback #${newPos + 1}`);
  notifyRunningDaemons(deps, 'move');
}

/**
 * Phase 1926 Step D：provider 登录/登出（pi-ai 原生 login 流）。
 * label → config 里的 provider（primary/fallback）→ preset.piAiProvider；
 * --type 缺省取 provider 首选（oauth 优先，其次 api_key 交互登录）。
 * loadGlobal 先执行（Credentials owner backend 注册同点，见 config-load.ts）。
 */
async function providerLogin(deps: ConfigCommandDeps, label: string, opts: { type?: string }): Promise<void> {
  const config = deps.rootConfig.loadGlobal();
  const hit = findProviderIndex(config, label);
  if (!hit) {
    throw new CliError(`Provider "${label}" not found (check "chestnut config provider list")`);
  }
  const entry = hit.type === 'primary' ? config.llm.primary : config.llm.fallbacks![hit.index];
  const preset = entry.preset ? PRESETS[entry.preset] : undefined;
  const piAiProvider = preset?.piAiProvider;
  if (!piAiProvider) {
    throw new CliError(
      `Provider "${label}" (preset "${entry.preset ?? 'none'}") has no pi-ai catalog provider; ` +
      `login is only available for catalog presets (api key goes to "config provider add" / reconfigure)`,
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
    credentials: createUserPiAiCredentialStore({ fsFactory: deps.fsFactory }),
  });
  configAudit(deps).write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_login', `label=${label}`, `type=${type}`);
  notifyRunningDaemons(deps, 'login');
}

async function providerLogout(deps: ConfigCommandDeps, label: string): Promise<void> {
  const config = deps.rootConfig.loadGlobal();
  const hit = findProviderIndex(config, label);
  if (!hit) {
    throw new CliError(`Provider "${label}" not found (check "chestnut config provider list")`);
  }
  const entry = hit.type === 'primary' ? config.llm.primary : config.llm.fallbacks![hit.index];
  const preset = entry.preset ? PRESETS[entry.preset] : undefined;
  const piAiProvider = preset?.piAiProvider;
  if (!piAiProvider) {
    throw new CliError(`Provider "${label}" has no pi-ai catalog provider; no stored credential to remove`);
  }
  await runProviderLogout({
    piAiProvider,
    credentials: createUserPiAiCredentialStore({ fsFactory: deps.fsFactory }),
  });
  configAudit(deps).write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_logout', `label=${label}`);
  notifyRunningDaemons(deps, 'logout');
}

// Build the config command
interface ConfigCommandDeps {
  fsFactory: (baseDir: string) => FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'isInitialized' | 'loadGlobal' | 'saveGlobal' | 'mutateGlobalLocked' | 'patchPrimary'>;
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
