/**
 * @module L6.CLI.Claw.Chat
 */

import * as path from 'path';
import {
  loadGlobalConfig, clawExists, getClawDir,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { CliError } from '../errors.js';
import { runChatViewport } from './chat-viewport.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { getWorkspaceRoot, resolveDaemonEntry } from '../../foundation/paths.js';
import { DAEMON_LOG } from '../../daemon/constants.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function chatCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

  if (!clawExists(deps, name)) {
    throw new CliError(`Claw "${name}" does not exist. Try \`clawforum claw list\` to see existing claws.`);
  }

  const clawDir = getClawDir(name);
  const globalConfig = loadGlobalConfig(deps, CONFIG_DEFAULTS);
  const { audit: systemAudit } = createDirContext(deps, clawDir);
  await runChatViewport({
    agentDir: clawDir,
    label: name,
    audit: systemAudit,
    fsFactory: deps.fsFactory,
    ensureDaemon: async () => {
      const pm = createProcessManagerForCLI(deps);
      if (!pm.isAlive(makeClawId(name))) {
        console.log(`Starting Claw "${name}" daemon...`);
        const daemonEntryPath = resolveDaemonEntry(deps.fsFactory(clawDir));
        const pid = await pm.spawn(makeClawId(name), {
          command: 'node',
          args: [daemonEntryPath, name],
          logFile: path.join(clawDir, DAEMON_LOG),
          env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
        });
        console.log(`Started (PID: ${pid})`);
      }
    },
    showRecapStream: globalConfig.viewport?.show_recap_stream,
    showSystemMessages: globalConfig.viewport?.show_system_messages,
    showContractEvents: globalConfig.viewport?.show_contract_events,
    trimOutputNewlines: globalConfig.viewport?.trim_output_newlines,
  });
}
