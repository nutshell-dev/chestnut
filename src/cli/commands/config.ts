/**
 * config command - Manage LLM provider configuration
 */

import * as path from 'path';
import * as readline from 'readline';
import { Command } from 'commander';
import type { RootConfigAdmin } from '../../assembly/index.js';
import type {
  LLMConfigurationAdmin,
  LLMRawConfigView,
} from '../../core/llm-configuration/index.js';
import {
  createAuthenticationCapability,
  LLMConfigurationCredentialUnavailableError,
  createLLMNotificationStore,
  classifyApiKeyConfigValue,
  runLLMSetupWorkflow,
  type LLMSetupWorkflowEvent,
} from '../../core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../../core/llm-configuration/setup.js';
import { llmProviderCatalog, llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
const { catalogProviderLoginMetadata } = llmProviderCatalog;
const { PROVIDER_NO_LABEL_SENTINEL } = llmProviderConfigContract;

import { createProcessManagerForCLI, describeLiveness } from '../../foundation/process-manager/index.js';
import { CliError } from '../errors.js';
// phase 1874 Step B: 终端文本原语经 viewport 模块 barrel（CLIProtocol 有 zod-only bare 白名单、不容 string-width）
import { fitLine } from '../../viewport/index.js';
import { cliAction, type SupervisionPolicy } from '../supervision-policy.js';
import { DEFAULT_TERMINAL_WIDTH } from '../../viewport/index.js';
import {
  resolveClawDaemonDir,
  MOTION_CLAW_ID,
  requireMotionAccess,
} from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { formatErr, newUuid, sha256Hex } from '../../foundation/node-utils/index.js';
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
  SETUP_CANCELLED,
  SETUP_PROBE_FAILED_NOT_SAVED,
  setupConnectingLine,
} from '../../templates/messages/index.js';
import { promptReconfigure, formatLLMError, LLM_ERROR_HINTS } from '../llm-connection-check.js';
// Phase 2206 Step C：明文 key 不落 root config —— 经 Credentials owner 落 workspace 凭据文件、配置写 `${REF}`。
import {
  discardCreatedCredentials,
  promptRepairAction,
  type StoredCredential,
} from '../first-run-setup.js';
import {
  makeExplicitSetupDraft,
  type ExplicitSetupDraft,
} from '../setup-provider-catalog.js';
import {
  collectExplicitLLMConfig,
  repairExplicitLLMConfig,
} from '../llm-config-editor.js';
import {
  emitLLMSetupWorkflowAudit,
  formatSetupProbeFailureLines,
  makeLLMSetupWorkflowProbe,
  recheckLLMSetupIdentity,
} from '../setup-provider-probe.js';
import { question } from '../utils/prompt.js';
import { shapeCommand, getConfigCommandSpec, type CommandShapeSpec } from '../../cli-protocol/index.js';
// Phase 1926 Step D：provider login/logout 运行缝（pi-ai 原生 login 流 + Credentials owner 持久化）
import { runProviderLogin, runProviderLogout, providerLoginTypes, type ProviderLoginType } from '../llm-login.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';
import {
  formatAmbiguousProviderReference,
  formatProviderTarget,
  providerAmbiguityMatchSource,
  providerCandidateFacts,
  providerEntryFor,
  providerLabelExists,
  providerTargetFingerprint,
  resolveProviderReference,
  summarizeProviderBaseUrl,
  type ProviderReferenceResolution,
  type ResolvedProviderReference,
} from './provider-reference.js';

function reportDegradedConfigWrite(target: string, write: AtomicWriteResult): void {
  if (write.kind === 'durable') return;
  const errorSummary = formatErr(write.error).replace(/\s+/g, ' ').trim().slice(0, 240);
  console.error(`⚠ ${target} committed with degraded durability (kind=${write.kind}): ${errorSummary}`);
}

function reportRuntimeReadiness(deps: ConfigCommandDeps): void {
  try {
    deps.llmConfiguration.store.readSnapshot();
  } catch (error) {
    if (error instanceof LLMConfigurationCredentialUnavailableError) {
      console.error(
        `⚠ Configuration saved, but LLM runtime is not ready: credential unavailable (${error.ref}).`,
      );
      return;
    }
    console.error(`⚠ Configuration saved, but runtime readiness check failed: ${formatErr(error)}`);
  }
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

function emitProviderAmbiguityAudit(
  audit: AuditLog,
  config: LLMRawConfigView,
  resolution: Extract<ProviderReferenceResolution, { kind: 'ambiguous_provider_reference' }>,
): void {
  audit.write(
    CLI_AUDIT_EVENTS.CONFIG_PROVIDER_REFERENCE_REJECTED,
    'reason=ambiguous_provider_reference',
    `revision=${config.revision?.id ?? 'unavailable'}`,
    `reference_sha256=${sha256Hex(resolution.reference)}`,
    `reference_chars=${resolution.reference.length}`,
    `match=${providerAmbiguityMatchSource(resolution)}`,
    `candidate_count=${resolution.candidates.length}`,
    ...resolution.candidates.map(hit => `candidate=${JSON.stringify(providerCandidateFacts(hit))}`),
  );
}

function requireProviderReference(
  config: LLMRawConfigView,
  reference: string,
  notFoundMessage = `Provider "${reference}" not found`,
  audit?: AuditLog,
): ResolvedProviderReference {
  const resolution = resolveProviderReference(config, reference);
  if (resolution.kind === 'not_found') throw new CliError(notFoundMessage);
  if (resolution.kind === 'ambiguous_provider_reference') {
    const error = new CliError(formatAmbiguousProviderReference(resolution));
    if (audit) {
      try {
        emitProviderAmbiguityAudit(audit, config, resolution);
      } catch (auditError) {
        // The original ambiguity remains the command failure even when its evidence cannot be persisted.
        console.error(`Provider ambiguity audit write failed: ${formatErr(auditError)}`);
      }
    }
    throw error;
  }
  return resolution;
}

class ProviderTargetDriftError extends CliError {
  readonly kind = 'provider_target_drift';

  constructor() {
    super('Provider configuration or target changed before mutation; no changes applied (provider_target_drift).');
    this.name = 'ProviderTargetDriftError';
  }
}

interface ProviderMutationGuard {
  readonly revision: string;
  readonly targetFingerprint: string;
}

function captureProviderMutationGuard(
  config: LLMRawConfigView,
  found: ResolvedProviderReference,
): ProviderMutationGuard {
  if (config.revision === undefined) throw new ProviderTargetDriftError();
  return {
    revision: config.revision.id,
    targetFingerprint: providerTargetFingerprint(config, found),
  };
}

function requireStableProviderReference(
  fresh: LLMRawConfigView,
  reference: string,
  expected: ProviderMutationGuard,
  audit: AuditLog,
): ResolvedProviderReference {
  if (fresh.revision?.id !== expected.revision) throw new ProviderTargetDriftError();
  const freshFound = requireProviderReference(fresh, reference, undefined, audit);
  if (providerTargetFingerprint(fresh, freshFound) !== expected.targetFingerprint) {
    throw new ProviderTargetDriftError();
  }
  return freshFound;
}

// phase 1452 Step B: config mutation 子命令 saveGlobal 成功侧 CLI audit。
// phase 1879 Step D: audit 创建统一经 action scope（有 scope 同 dir 复用 + 统一 dispose；
// 无 scope 直调回落裸创建）；与 notifyRunningDaemons 同根（chestnutRoot）。
function configAudit(deps: ConfigCommandDeps): AuditLog {
  return actionAuditFor(getChestnutRoot(), deps);
}

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

// provider add command: the editor owns configuration fields; this adapter owns label/target.
function providerAddSetupDraft(draft: ExplicitSetupDraft, label: string) {
  return makeExplicitSetupDraft(draft, { label });
}

async function providerAdd(deps: ConfigCommandDeps): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadRaw();
  const rl = createRL();
  const created: StoredCredential[] = [];
  // A provider-add credential belongs to this new entry, not to another label/method.
  const editorOptions = { credentialSeed: `provider-add-${newUuid()}` };
  let commitAttempted = false;
  let committed = false;

  try {
    const collected = await collectExplicitLLMConfig(deps, rl,
      (prompt, defaultValue) => question(rl, prompt, defaultValue), created, editorOptions);
    if (collected.kind === 'cancelled') {
      console.log(SETUP_CANCELLED);
      return;
    }
    let draft = collected.draft;
    const defaultLabel = draft.choice.id;
    const labelInput = await question(rl, '\nLabel (press Enter to use service name)', defaultLabel);
    const label = labelInput || defaultLabel;
    if (label === PROVIDER_NO_LABEL_SENTINEL) {
      throw new CliError('Provider label "(no label)" is reserved for a missing label');
    }
    if (providerLabelExists(config, label)) {
      throw new CliError(`A provider with label "${label}" already exists`);
    }

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
        `\nAdd ${draft.choice.label} (${draft.model}) as primary? ` +
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

    // Custom preview/confirmation already happened inside the shared editor.
    const probeCandidates = draft.choice.probeCandidates;
    console.log(setupConnectingLine(draft.choice.label, draft.model));
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
      providerAddSetupDraft(draft, label),
      role === 'primary' ? { kind: 'primary' } : { kind: 'fallback', position: positionFromPrompt },
      async (attempt) => {
        if (attempt.candidates.some(candidate => candidate.kind === 'candidate')) {
          formatSetupProbeFailureLines(attempt.candidates.map(candidate => ({
            candidate: { baseUrl: candidate.url ?? '', label: candidate.identity },
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
        const repaired = await repairExplicitLLMConfig(
          action, deps, rl, (prompt, defaultValue) => question(rl, prompt, defaultValue), draft, created,
          editorOptions,
        );
        if (repaired.kind === 'cancelled') return { kind: 'cancel', reason: repaired.reason };
        draft = repaired.draft;
        return { kind: 'repair', draft: providerAddSetupDraft(draft, label) };
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
    if (role === 'primary') console.log(`\n✓ Provider "${label}" is now primary`);
    else console.log(`\n✓ Provider "${label}" added as fallback`);
    setupAudit.write(CLI_AUDIT_EVENTS.CONFIG_SAVED, 'command=provider_add', `label=${label}`, `role=${role}`);
    await notifyRunningDaemons(deps, 'add', outcome.commit.revision);
    console.log(`✓ ${outcome.verified.model}`);
    reportRuntimeReadiness(deps);

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
  const pLabel = primary.label ?? PROVIDER_NO_LABEL_SENTINEL;
  const pBaseUrl = primary.base_url ? summarizeProviderBaseUrl(primary.base_url) : '-';
  const pApiKey = formatApiKeyStatus(primary.api_key, deps);
  console.log(`  ${'PRIMARY'.padEnd(10)} ${primary.provider_id.padEnd(10)} ${pLabel.padEnd(15)} ${primary.model.padEnd(18)} ${pApiKey.padEnd(24)} ${fitLine(pBaseUrl, urlWidth)}`);

  // Fallbacks
  fallbacks.forEach((f, i) => {
    const fLabel = f.label ?? PROVIDER_NO_LABEL_SENTINEL;
    const fBaseUrl = f.base_url ? summarizeProviderBaseUrl(f.base_url) : '-';
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
  const config = deps.llmConfiguration.loadRaw();
  
  const found = requireProviderReference(config, label, undefined, configAudit(deps));
  if (found.candidate.role === 'primary') {
    throw new CliError('Cannot remove primary provider. Use "set-primary" to change it first.');
  }
  const expected = captureProviderMutationGuard(config, found);

  let actualTarget = found;
  // Phase 2216：锁内重放必须命中同一 revision 与同一目标，不得改投新 entry。
  const write = await deps.llmConfiguration.mutateGlobalLocked((fresh) => {
    const freshFound = requireStableProviderReference(fresh, label, expected, configAudit(deps));
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
    `label=${actualTarget.candidate.label ?? PROVIDER_NO_LABEL_SENTINEL}`,
    `label_state=${actualTarget.candidate.label === undefined ? 'missing' : 'present'}`,
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
  const config = deps.llmConfiguration.loadRaw();
  
  const found = requireProviderReference(config, label, undefined, configAudit(deps));
  if (found.candidate.role === 'primary') {
    console.log(`Provider (${formatProviderTarget(found)}) is already primary`);
    return;
  }
  
  const expected = captureProviderMutationGuard(config, found);
  const currentPrimary = config.llm.primary;

  console.log(`\nCurrent primary (${currentPrimary.label ?? PROVIDER_NO_LABEL_SENTINEL}) will become fallback #1.`);
  const rl = createRL();
  const confirm = await question(rl, 'Confirm?', 'N');
  rl.close();

  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled');
    return;
  }

  let actualTarget = found;
  // Phase 2216：用户确认后只允许提交到预检的同一目标。
  const write = await deps.llmConfiguration.mutateGlobalLocked((fresh) => {
    const freshFound = requireStableProviderReference(fresh, label, expected, configAudit(deps));
    if (freshFound.candidate.role === 'primary') {
      throw new CliError(`Provider (${formatProviderTarget(freshFound)}) is already primary`);
    }
    const freshPrimary = fresh.llm.primary;
    const target = fresh.llm.fallbacks![freshFound.candidate.index];
    fresh.llm.fallbacks!.splice(freshFound.candidate.index, 1);
    fresh.llm.fallbacks!.unshift(freshPrimary);
    fresh.llm.primary = target;
    actualTarget = {
      ...freshFound,
      candidate: { ...freshFound.candidate, role: 'primary', index: -1 },
    };
  });
  reportDegradedConfigWrite('LLM global config', write);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_set_primary',
    `label=${actualTarget.candidate.label ?? PROVIDER_NO_LABEL_SENTINEL}`,
    `label_state=${actualTarget.candidate.label === undefined ? 'missing' : 'present'}`,
    `role=${actualTarget.candidate.role}`,
    `match=${actualTarget.matchedBy}`,
  );
  console.log(`✓ Provider (${formatProviderTarget(actualTarget)}) is now primary`);
  await notifyRunningDaemons(deps, 'set-primary');

  // phase 451: 改 primary 必 probe
  console.log('\nTesting new primary connection...');
  const probe = await makeLLMSetupWorkflowProbe(deps)(
    { provider: deps.llmConfiguration.store.read().primary },
    { kind: 'direct' },
  );
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
  const config = deps.llmConfiguration.loadRaw();
  
  const found = requireProviderReference(config, label, undefined, configAudit(deps));
  if (found.candidate.role === 'primary') {
    throw new CliError('Cannot move primary provider');
  }
  
  const newPos = parseInt(position, 10) - 1;
  const fallbacks = config.llm.fallbacks!;

  if (Number.isNaN(newPos) || newPos < 0 || newPos >= fallbacks.length) {
    throw new CliError(`Invalid position. Must be 1-${fallbacks.length}, got: ${position}`);
  }

  const expected = captureProviderMutationGuard(config, found);
  let actualTarget = found;
  let actualPosition = newPos;
  // Phase 2216：位置与输出均由锁内实际提交结果派生。
  const write = await deps.llmConfiguration.mutateGlobalLocked((fresh) => {
    const freshFound = requireStableProviderReference(fresh, label, expected, configAudit(deps));
    if (freshFound.candidate.role === 'primary') {
      throw new CliError('Cannot move primary provider');
    }
    actualTarget = freshFound;
    const freshFallbacks = fresh.llm.fallbacks!;
    const clampedPos = Math.min(newPos, freshFallbacks.length - 1);
    const [removed] = freshFallbacks.splice(freshFound.candidate.index, 1);
    freshFallbacks.splice(clampedPos, 0, removed);
    actualPosition = freshFallbacks.indexOf(removed);
    if (actualPosition < 0) throw new CliError('Moved provider is absent from the committed fallback order');
    actualTarget = {
      ...freshFound,
      candidate: { ...freshFound.candidate, index: actualPosition },
    };
  });
  reportDegradedConfigWrite('LLM global config', write);
  configAudit(deps).write(
    CLI_AUDIT_EVENTS.CONFIG_SAVED,
    'command=provider_move',
    `label=${actualTarget.candidate.label ?? PROVIDER_NO_LABEL_SENTINEL}`,
    `label_state=${actualTarget.candidate.label === undefined ? 'missing' : 'present'}`,
    `role=${actualTarget.candidate.role}`,
    `match=${actualTarget.matchedBy}`,
    `position=${actualPosition + 1}`,
  );
  console.log(`✓ Provider (${formatProviderTarget(actualTarget)}) moved to fallback #${actualPosition + 1}`);
  await notifyRunningDaemons(deps, 'move');
}

/**
 * Phase 1926 Step D：provider 登录/登出（pi-ai 原生 login 流）。
 * label → config 里的 canonical provider（primary/fallback）→ login metadata；
 * --type 缺省取 provider 首选（oauth 优先，其次 api_key 交互登录）。
 * Raw target selection does not require the current login credential to exist.
 */
function loginMetadataForEntry(entry: ReturnType<typeof providerEntryFor>) {
  const providerId = entry.provider_id;
  return providerId
    && !providerId.startsWith('custom:')
    && entry.catalog_provider === undefined
    ? catalogProviderLoginMetadata(providerId)
    : undefined;
}

async function providerLogin(deps: ConfigCommandDeps, label: string, opts: { type?: string }): Promise<void> {
  // Assembly 仅负责 legacy root 迁移协调；迁移后的业务读写全部走 L4。
  await deps.rootConfig.migrateLLMConfiguration();
  await deps.llmConfiguration.migrateLegacyApiKeys(configAudit(deps));
  const config = deps.llmConfiguration.loadRaw();
  const hit = requireProviderReference(
    config,
    label,
    `Provider "${label}" not found (check "chestnut config provider list")`,
    configAudit(deps),
  );
  const entry = providerEntryFor(config, hit.candidate);
  const login = loginMetadataForEntry(entry);
  if (!login) {
    throw new CliError(
      `Provider "${label}" has no pi-ai catalog provider; ` +
      `login is only available for catalog providers (api key goes to "config provider add" / reconfigure)`,
    );
  }
  const piAiProvider = login.providerId;
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
      `Provider "${piAiProvider}" has no interactive login (ambient-only: ${login.authHint ?? 'configure environment'})`,
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
  const config = deps.llmConfiguration.loadRaw();
  const hit = requireProviderReference(
    config,
    label,
    `Provider "${label}" not found (check "chestnut config provider list")`,
    configAudit(deps),
  );
  const entry = providerEntryFor(config, hit.candidate);
  const login = loginMetadataForEntry(entry);
  if (!login) {
    throw new CliError(`Provider "${label}" has no pi-ai catalog provider; no stored credential to remove`);
  }
  const piAiProvider = login.providerId;
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
    'loadGlobal' | 'loadRaw' | 'mutateGlobalLocked' | 'patchPrimary' | 'readRevision' |
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
    .action(action('disabled', () => providerAdd(deps)));

  shapeCommand(providerCmd.command('list'), configSpec('config/provider/list'))
    .action(action('observe_only', () => providerList(deps)));

  shapeCommand(providerCmd.command('remove <label>'), configSpec('config/provider/remove'))
    .action(action('disabled', (label: string) => providerRemove(deps, label)));

  shapeCommand(providerCmd.command('set-primary <label>'), configSpec('config/provider/set-primary'))
    .action(action('disabled', (label: string) => providerSetPrimary(deps, label)));

  shapeCommand(providerCmd.command('move <label> <position>'), configSpec('config/provider/move'))
    .action(action('disabled', (label: string, position: string) => providerMove(deps, label, position)));

  shapeCommand(providerCmd.command('login <label>'), configSpec('config/provider/login'))
    .action(action('disabled', (label: string, opts: { type?: string }) => providerLogin(deps, label, opts)));

  shapeCommand(providerCmd.command('logout <label>'), configSpec('config/provider/logout'))
    .action(action('disabled', (label: string) => providerLogout(deps, label)));

  configCommand.addCommand(providerCmd);
  return configCommand;
}
