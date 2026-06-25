/**
 * @module L6.CLI.Claw.Chat
 */

import { getWorkspaceRoot, getChestnutRoot } from '../../core/claw-topology/claw-instance-paths.js';
import { resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/claw-instance-paths.js';
import { CliError } from '../errors.js';
import { runChatViewport } from './chat-viewport.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { resolveDaemonEntry } from '../../assembly/spawn-entry.js';
import { DAEMON_LOG } from '../../daemon/constants.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export async function chatCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string): Promise<void> {
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist. Try \`chestnut claw list\` to see existing claws.`);
  }

  const clawDir = getClawDir(name);
  const globalConfig = loadGlobalConfig(deps);
  const { audit: systemAudit } = createDirContext(deps, clawDir);
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
        const daemonEntryPath = resolveDaemonEntry(deps.fsFactory(clawDir));
        const pid = await pm.spawn(resolveClawDaemonDir(makeClawId(name)), {
          command: 'node',
          args: [daemonEntryPath, name],
          logFile: path.join(clawDir, DAEMON_LOG),
          env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
        });
        console.log(`Started (PID: ${pid})`);
      }
      // phase 398 Step E (review N1): mirror motion.ts:213-215 / start.ts —
      // 没 watchdog 看护、daemon 崩了无人重启 (phase 324 H3 dead code on chat path)。
      const { ensureWatchdog } = await import('../../watchdog/ensure.js');
      await ensureWatchdog(deps.fsFactory);
    },
    showRecapStream: globalConfig.viewport.show_recap_stream,
    showSystemMessages: globalConfig.viewport.show_system_messages,
    showContractEvents: globalConfig.viewport.show_contract_events,
    trimOutputNewlines: globalConfig.viewport.trim_output_newlines,
    userInputInlineMaxChars: globalConfig.viewport.user_input_inline_max_chars,
  });
}
