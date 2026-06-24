/**
 * @module L6.CLI.Claw.Create
 */

import { loadGlobalConfig, saveClawConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/claw-instance-paths.js';
import { CLAW_SUBDIRS } from '../../assembly/claw-subdirs.js';
// path module intentionally not used in this file after refactor
import { CliError } from '../errors.js';
import { buildAgentsMdTemplate } from '../../templates/prompts/index.js';
import { CLAW_SPEC_FILE } from '../../foundation/claw-identity/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';

export async function createCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, name: string, opts?: { audit?: AuditLog }): Promise<void> {
  const audit = opts?.audit;
  // Load global config (ensures initialized)
  loadGlobalConfig(deps);
  
  // Check if claw already exists
  const configPath = getClawConfigPath(name);
  if (clawExists(deps, configPath)) {
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
  
  saveClawConfig(deps, configPath, config);
  
  // Create AGENTS.md template
  const agentsTemplate = buildAgentsMdTemplate(name);
  fileSystem.writeAtomicSync(CLAW_SPEC_FILE, agentsTemplate);
  
  audit?.write(CLI_AUDIT_EVENTS.CLAW_CREATE, `name=${name}`);
  console.log(`✓ Created Claw "${name}"`);
  console.log(`  Location: ${clawDir}`);
  console.log(`\nNext step: chestnut claw ${name} chat`);
}
