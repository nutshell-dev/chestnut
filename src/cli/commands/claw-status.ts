/**
 * @module L6.CLI.Claw.Status
 *
 * `chestnut claw <name> status` — inspection of another claw's business state
 * (contract / tasks / storage). Phase 1472 Step C.
 *
 * Emits status error audit events (CONTRACT_ERROR, TASK_PENDING_ERROR,
 * TASK_RUNNING_ERROR).
 *
 * 设计：
 * - 复用 L5.StatusService 的 aggregator + format helper（共用方 = agent status tool）
 * - fs root 切到目标 claw 的 clawDir、依赖 atomic write 约定（contract/task queue 已 atomic）
 *   不加锁、读到瞬时一致 view
 * - audience：motion 常用（查 worker claw 状态）；用户也可直接调
 *   `chestnut status` （进程层）留给用户看 watchdog/motion/claws alive 概览
 * - format 与 agent status tool 输出一致、避免漂移；多 `Claw:` header 标 namespace
 */

import * as path from 'path';
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
// CLAWS_DIR removed: phase 263
// phase 1879 Step B: ContractSystem 装配归 Assembly 窄 action context（1874 Step F 形态）——
// CLI 不再直构造 ContractSystem/ToolRegistry/AuditLog；audit 由 context own、动作终态 dispose。
import { createContractActionContext } from '../../assembly/index.js';
import {
  computeContractView,
  computeTaskView,
  computeStorageView,
  formatContractView,
  formatTaskView,
  formatStorageView,
} from '../../core/status-service/index.js';
import { STATUS_AUDIT_EVENTS } from '../../core/status-service/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

interface ClawStatusOpts {
  json?: boolean;
}

export async function clawStatusCommand(
  deps: ClawCommandDeps,
  name: string,
  opts: ClawStatusOpts = {},
): Promise<void> {
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }

  const clawDir = getClawDir(name);
  const clawFs = deps.fsFactory(clawDir);

  const action = await createContractActionContext(deps, name);
  try {
    const audit = action.audit;

    const [contractView, taskView, storageView] = await Promise.all([
      computeContractView(action.system),
      computeTaskView(clawFs),
      computeStorageView(clawFs),
    ]);

    if (contractView.type === 'error') {
      audit.write(STATUS_AUDIT_EVENTS.CONTRACT_ERROR, `error=${contractView.message}`);
    }
    if (taskView.type === 'counts' && taskView.pendingError) {
      audit.write(STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR, `error=${taskView.pendingError}`);
    }
    if (taskView.type === 'counts' && taskView.runningError) {
      audit.write(STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR, `error=${taskView.runningError}`);
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            claw: name,
            clawDir: path.resolve(clawDir),
            contract: contractView,
            tasks: taskView,
            storage: storageView,
          },
          null,
          2,
        ),
      );
      return;
    }

    const lines: string[] = [];
    lines.push(`Claw: ${name}`);
    // phase 369 §4 (review-2026-06-13): 'string:' 是 typeof 泄漏、不是字段语义；改 'Dir:'
    lines.push(`Dir: ${path.resolve(clawDir)}`);
    lines.push(formatContractView(contractView));
    lines.push(formatTaskView(taskView));
    lines.push(...formatStorageView(storageView));
    console.log(lines.join('\n'));
  } finally {
    action.dispose();
  }
}
