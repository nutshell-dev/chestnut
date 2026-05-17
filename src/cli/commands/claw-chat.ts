/**
 * @module L6.CLI.Claw.Chat
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  loadGlobalConfig, clawExists, getClawDir, loadClawConfig, buildLLMConfig,
} from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { CliError } from '../errors.js';
import { runChatViewport } from './chat-viewport.js';
import { createDirContext, createProcessManagerForCLI } from '../utils/factories.js';
import { LOGS_DIR } from '../../types/paths.js';
import { PROCESS_SPAWN_CONFIRM_MS } from '../../foundation/process-manager/index.js';
import { getWorkspaceRoot } from '../../foundation/config/paths.js';

export async function chatCommand(name: string): Promise<void> {
  loadGlobalConfig(CONFIG_DEFAULTS);

  if (!clawExists(name)) {
    throw new CliError(`Claw "${name}" does not exist. Try \`clawforum claw list\` to see existing claws.`);
  }

  const clawDir = getClawDir(name);
  const globalConfig = loadGlobalConfig(CONFIG_DEFAULTS);
  const { audit: systemAudit } = createDirContext(clawDir);
  await runChatViewport({
    agentDir: clawDir,
    label: name,
    audit: systemAudit,
    ensureDaemon: async () => {
      const pm = createProcessManagerForCLI();
      if (!pm.isAlive(name)) {
        console.log(`Starting Claw "${name}" daemon...`);
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const bundleEntry = path.join(thisDir, 'daemon-entry.js');
        const daemonEntryPath = fs.existsSync(bundleEntry) ? bundleEntry : path.resolve(thisDir, '..', '..', 'daemon-entry.js');
        const pid = await pm.spawn(name, {
          command: 'node',
          args: [daemonEntryPath, name],
          logFile: path.join(clawDir, LOGS_DIR, 'daemon.log'),
          env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
        });
        console.log(`Started (PID: ${pid})`);
        // Wait for daemon to initialize
        await new Promise(resolve => setTimeout(resolve, PROCESS_SPAWN_CONFIRM_MS));
      }
    },
    showRecapStream: globalConfig.viewport?.show_recap_stream,
    showSystemMessages: globalConfig.viewport?.show_system_messages,
    showContractEvents: globalConfig.viewport?.show_contract_events,
    trimOutputNewlines: globalConfig.viewport?.trim_output_newlines,
  });
}
