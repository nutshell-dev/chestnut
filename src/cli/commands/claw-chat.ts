/**
 * @module L6.CLI.Claw.Chat
 */

import { getWorkspaceRoot, getChestnutRoot } from '../../core/claw-topology/index.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import * as path from 'path';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import { runChatViewport } from './chat-viewport.js';
import { createViewportAudit } from './viewport-audit-events.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { resolveDaemonEntry } from '../../daemon/index.js';
import { DAEMON_LOG } from '../../daemon/index.js';
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
      if (!pm.isAlive(resolveClawDaemonDir(makeClawId(name)))) {
        console.log(`Starting Claw "${name}" daemon...`);
        const daemonEntryPath = resolveDaemonEntry();
        const pid = await pm.spawn(resolveClawDaemonDir(makeClawId(name)), {
          command: 'node',
          args: [daemonEntryPath, name],
          logFile: path.join(clawDir, DAEMON_LOG),
          env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
        });
        console.log(`Started (PID: ${pid})`);
      }
    },
    showRecapStream: globalConfig.viewport.show_recap_stream,
    showSystemMessages: globalConfig.viewport.show_system_messages,
    showContractEvents: globalConfig.viewport.show_contract_events,
    trimOutputNewlines: globalConfig.viewport.trim_output_newlines,
    userInputInlineMaxChars: globalConfig.viewport.user_input_inline_max_chars,
  });
}
