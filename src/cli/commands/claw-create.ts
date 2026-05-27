/**
 * @module L6.CLI.Claw.Create
 */

import {
  loadGlobalConfig, saveClawConfig, clawExists, getClawDir, CLAW_SUBDIRS,
} from '../../foundation/config/index.js';
// path module intentionally not used in this file after refactor
import { CONFIG_DEFAULTS } from '../../assembly/config-defaults.js';
import { CliError } from '../errors.js';
import { buildAgentsMdTemplate } from '../../prompts/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';

export async function createCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, opts?: { audit?: AuditLog }): Promise<void> {
  const audit = opts?.audit;
  // Load global config (ensures initialized)
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
  
  // Check if claw already exists
  if (clawExists(deps, name)) {
    throw new CliError(`Claw "${name}" already exists`);
  }
  
  const clawDir = getClawDir(name);
  const fileSystem = deps.fsFactory(clawDir);
  
  // Create directory structure (using shared constants)
  for (const dir of CLAW_SUBDIRS) {
    fileSystem.ensureDirSync(dir);
  }
  
  // Create claw config (inherits from global)
  const config = {
    name,
    tool_profile: 'full' as const,
    max_concurrent_tasks: 3,
  };
  
  saveClawConfig(deps, name, config);
  
  // Create AGENTS.md template
  const agentsTemplate = buildAgentsMdTemplate(name);
  fileSystem.writeAtomicSync('AGENTS.md', agentsTemplate);
  
  audit?.write(CLI_AUDIT_EVENTS.CLAW_CREATE, `name=${name}`);
  console.log(`✓ Created Claw "${name}"`);
  console.log(`  Location: ${clawDir}`);
  console.log(`\nNext step: clawforum claw chat ${name}`);
}
