/**
 * init command - Initialize chestnut workspace
 *
 * Phase 1976：首次配置的草稿、probe、修复与提交统一由 first-run-setup owner。
 * init 不再在 probe 前发布 config/ready，也不再持有 start 专用 reconfigure 菜单。
 */

import { formatErr } from "../../foundation/node-utils/index.js";
import type { RootConfigAdmin } from '../../assembly/index.js';
import { CliError } from '../errors.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { VerifiedLLMConfig } from '../llm-connection-check.js';
import {
  LLMConfigurationNotFoundError,
  type LLMConfigurationAdmin,
} from '../../core/llm-configuration/index.js';
import { runFirstRunSetup } from '../first-run-setup.js';
import { requireMotionAccess } from '../../core/claw-topology/index.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';

interface InitCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'isInitialized' | 'loadGlobal' | 'saveGlobalExclusive' | 'migrateLLMConfiguration' | 'inspectInitialization' | 'completeInitialization'>;
  llmConfiguration: Pick<LLMConfigurationAdmin, 'store'>;
}

/**
 * init 结果（Phase 1926 Step C）：`verified` 是带配置身份的已验证事实——
 * init 本次对**该快照**完成真实 LLM 调用验证；start 门控仅在 identity 与当前
 * 快照相等时复用。取消 / 并发 loser 一律缺席——未验证事实不猜。
 */
export interface InitCommandResult {
  verified?: VerifiedLLMConfig;
}

export async function initCommand(deps: InitCommandDeps, silent = false, extraDeps?: { audit?: AuditLog }): Promise<InitCommandResult> {
  requireMotionAccess(getCapturedCliMotionAccess('configure'), 'configure', 'init');
  const audit = extraDeps?.audit;
  // 既有 workspace 可能同时残留 legacy shared/root；任何状态诊断或 strict
  // store.read 之前先经同一显式迁移入口收敛，避免崩溃恢复误报 invalid。
  if (deps.rootConfig.isInitialized()) await deps.rootConfig.migrateLLMConfiguration();
  // Phase 1911 Step D（RACE-CONFIG-INIT-PARTIAL-PUBLISH）：typed 初始化状态。
  // ready 依据 = root config + ready marker + 必需布局核验，不是 root YAML exists。
  const inspection = deps.rootConfig.inspectInitialization();
  const initState = inspection.state;
  if (initState === 'ready') {
    console.log('✓ Already initialized (.chestnut/config.yaml exists)');
    return {};
  }
  if (initState === 'invalid') {
    throw new CliError(
      `Workspace initialization structure is invalid (${inspection.reason}). ` +
      'Inspect .chestnut/ manually; init will not overwrite it.',
    );
  }
  if (initState === 'in_progress') {
    try {
      deps.llmConfiguration.store.read();
      // L4 已提交：只恢复布局和 ready，不重跑 probe 或覆盖 winner。
      deps.rootConfig.completeInitialization();
      console.log('✓ Initialization completed (resumed an interrupted bootstrap; existing config kept)');
      return {};
    } catch (error) {
      if (!(error instanceof LLMConfigurationNotFoundError)) throw error;
      // root 非 LLM intent 已存在但 L4 尚未提交：重新收集并验证新 draft，
      // 随后复用 root intent，由 L4 独占 initialize 完成可恢复顺序。
    }
  }

  console.log('Initializing chestnut...\n');

  try {
    const outcome = await runFirstRunSetup(deps, { audit });

    if (outcome.kind === 'cancelled') {
      return {};
    }
    if (outcome.kind === 'concurrent') {
      console.log('✓ Already initialized (a concurrent init completed first; keeping its config)');
      return {};
    }

    console.log('\n✓ Initialized successfully!');
    if (!silent) {
      console.log('\nNext steps:');
      console.log('1. Create a Claw: chestnut claw <name> create');
      console.log('2. Start chatting: chestnut claw <name> chat');
    }
    return { verified: outcome.verified };

  } catch (error) {
    // phase 446 (review N3-H2): 内部已是 CliError 时直接重抛、不双包污染原文案
    if (error instanceof CliError) throw error;
    // phase 526: 保 cause、事后可还原 root error stack
    throw new CliError(`Init failed: ${formatErr(error)}`, { cause: error });
  }
}
