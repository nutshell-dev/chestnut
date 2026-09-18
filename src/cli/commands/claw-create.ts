/**
 * @module L6.CLI.Claw.Create
 */

import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { initializeClawLayout } from '../../assembly/index.js';
// path module intentionally not used in this file after refactor
import { CliError } from '../errors.js';
import { buildAgentsMdTemplate } from '../../templates/prompts/index.js';
import { CLAW_SPEC_FILE } from '../../foundation/claw-identity/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { ClawCreateCommandDeps } from './claw-command-deps.js';

export async function createCommand(deps: ClawCreateCommandDeps, name: string, opts?: { audit?: AuditLog }): Promise<void> {
  const audit = opts?.audit;
  // Load global config (ensures initialized)
  deps.rootConfig.loadGlobal();
  
  // Check if claw already exists
  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) !== undefined) {
    throw new CliError(`Claw "${name}" already exists`);
  }
  
  const clawDir = getClawDir(name);
  const fileSystem = deps.fsFactory(clawDir);
  
  initializeClawLayout(fileSystem);
  
  // Create claw config (inherits from global)
  const config = {
    name,
    tool_profile: 'full' as const,
    max_concurrent_tasks: 3,
  };
  
  deps.rootConfig.saveClaw(configPath, config);
  
  // Create AGENTS.md template
  const agentsTemplate = buildAgentsMdTemplate(name);
  fileSystem.writeAtomicSync(CLAW_SPEC_FILE, agentsTemplate);
  
  audit?.write(CLI_AUDIT_EVENTS.CLAW_CREATE, `name=${name}`);
  console.log(`✓ Created Claw "${name}"`);
  console.log(`  Location: ${clawDir}`);
  console.log(`\nNext step: chestnut claw ${name} chat`);
}
