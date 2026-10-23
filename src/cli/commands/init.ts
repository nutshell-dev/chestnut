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
import { runFirstRunSetup } from '../first-run-setup.js';

interface InitCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'isInitialized' | 'loadGlobal' | 'saveGlobal' | 'saveGlobalExclusive' | 'patchPrimary' | 'getInitializationState' | 'completeInitialization'>;
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
