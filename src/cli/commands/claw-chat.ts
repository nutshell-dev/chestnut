/**
 * @module L6.CLI.Claw.Chat
 */

import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
// phase 1874 Step B: viewport 独立模块入口（CLIProcess 只经 barrel 消费）
import { runChatViewport, createViewportAudit } from '../../viewport/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { createDaemonSpawnOptions } from '../../daemon/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export async function chatCommand(deps: ClawCommandDeps, name: string): Promise<void> {
  const globalConfig = deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }

  const clawDir = getClawDir(name);
  // phase 1279 Step A: viewport routing 由 Chat Viewport owner 工厂兑现（四高频事件落 viewport.tsv）
  const systemAudit = createViewportAudit(deps.fsFactory(clawDir), clawDir);
  await runChatViewport({
    agentDir: clawDir,
    label: name,
    audit: systemAudit,
    fsFactory: deps.fsFactory,
    ensureDaemon: async () => {
      const baseDir = getChestnutRoot();
      const pm = createProcessManagerForCLI({ ...deps, baseDir });
      const clawId = makeClawId(name);
      // Phase 1936 Step C: daemon ready 的唯一 capability = ensureRunning——
      // 已有 active/spawning winner 由 ProcessManager join exact generation 收敛，
      // CLI 不再组合 isAlive+spawn（TOCTOU）、不自行解释 ProcessSpawnConflictError；
      // typed failure 原样上抛，由 viewport 呈现为系统事件（显示归 viewport owner，
      // CLI 不再向 stdout 拼接启动文案）。
      // Phase 1464 Step B: spawn specification 归 Daemon 唯一 owner
      await pm.ensureRunning(resolveClawDaemonDir(clawId), createDaemonSpawnOptions({
        clawId,
        agentDir: clawDir,
        chestnutRoot: getChestnutRoot(),
      }));
    },
    showRecapStream: globalConfig.viewport.show_recap_stream,
    showSystemMessages: globalConfig.viewport.show_system_messages,
    showContractEvents: globalConfig.viewport.show_contract_events,
    trimOutputNewlines: globalConfig.viewport.trim_output_newlines,
    userInputInlineMaxChars: globalConfig.viewport.user_input_inline_max_chars,
  });
}
