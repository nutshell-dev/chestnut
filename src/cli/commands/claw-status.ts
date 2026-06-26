/**
 * @module L6.CLI.Claw.Status
 *
 * `chestnut claw <name> status` — read-only inspection of another claw's
 * business state (contract / tasks / storage). Phase 1472 Step C.
 *
 * 设计：
 * - 复用 L5.StatusService 的 aggregator + format helper（共用方 = agent status tool）
 * - fs root 切到目标 claw 的 clawDir、依赖 atomic write 约定（contract/task queue 已 atomic）
 *   不加锁、读到瞬时一致 view
 * - audience：motion 常用（查 worker claw 状态）；用户也可直接调
 *   `chestnut status` （进程层）留给用户看 watchdog/motion/claws alive 概览
 * - format 与 agent status tool 输出一致、避免漂移；多 `Claw:` header 标 namespace
 */

import { resolveChestnutRoot } from '../../core/claw-topology/index.js';
import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
// CLAWS_DIR removed: phase 263
import { routeNotifyClaw } from '../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { ContractSystem } from '../../core/contract/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import {
  computeContractView,
  computeTaskView,
  computeStorageView,
  formatContractView,
  formatTaskView,
  formatStorageView,
} from '../../core/status-service/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

interface ClawStatusOpts {
  json?: boolean;
}

export async function clawStatusCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  opts: ClawStatusOpts = {},
): Promise<void> {
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }

  const clawDir = getClawDir(name);
  const clawFs = deps.fsFactory(clawDir);
  const clawId = makeClawId(name);
  const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);

  const audit = createSystemAudit(clawFs, clawDir);
  const contractSystem = new ContractSystem({
    clawDir,
    clawId,
    fs: clawFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: deps.fsFactory,
    // clawsDir removed: phase 263
    notifyClaw: (targetClawId, message) => routeNotifyClaw(clawFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, audit),
  });

  const [contractView, taskView, storageView] = await Promise.all([
    computeContractView(contractSystem),
    computeTaskView(clawFs),
    computeStorageView(clawFs),
  ]);

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
}
