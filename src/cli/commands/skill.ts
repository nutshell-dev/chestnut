/**
 * Skill install commands
 *
 * User mode: install skill from local path to workspace
 * Internal mode: install dispatch-skill to a specific claw
 */

import * as path from 'path';
import { CLAWSPACE_DIR, getWorkspaceRoot } from '../../foundation/paths.js';
import { SKILLS_DIR_DEFAULT } from '../../foundation/skill-system/skill-paths.js';
import { DISPATCH_SKILLS_SUBDIR } from '../../foundation/paths.js';
import { getClawDir } from '../../foundation/config/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ClawId } from '../../foundation/identity/index.js';


/**
 * Copy directory recursively
 */
async function copyDir(deps: { fsFactory: (baseDir: string) => FileSystem }, src: string, dest: string): Promise<void> {
  const srcFs = deps.fsFactory(src);
  const destFs = deps.fsFactory(dest);
  await destFs.ensureDir('.');
  const entries = await srcFs.list('.');
  for (const entry of entries) {
    if (entry.isDirectory) {
      await copyDir(deps, path.join(src, entry.name), path.join(dest, entry.name));
    } else {
      const content = await srcFs.read(entry.name);
      await destFs.writeAtomic(entry.name, content);
    }
  }
}

/**
 * User mode: install skill from local path to workspace
 * - Copy to root/skills/{skillName}/
 * - Sync to motion/clawspace/dispatch-skills/{skillName}/
 */
export async function skillInstallUserCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, sourcePath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const root = getWorkspaceRoot();
  const absSource = path.resolve(sourcePath);

  // Skill name = source directory name
  const skillName = path.basename(absSource);

  // Verify SKILL.md exists
  const sourceFs = deps.fsFactory(absSource);
  if (!sourceFs.existsSync('SKILL.md')) {
    throw new CliError(`No SKILL.md found in ${absSource}`);
  }

  // 1. Copy to root level skills/{skillName}/
  const destUser = path.join(root, SKILLS_DIR_DEFAULT, skillName);
  const rootFs = deps.fsFactory(root);
  const userExists = rootFs.existsSync(path.join(SKILLS_DIR_DEFAULT, skillName));
  await copyDir(deps, absSource, destUser);
  audit?.write(CLI_AUDIT_EVENTS.SKILL_INSTALL, `mode=user`, `skill=${skillName}`);
  console.log(`${userExists ? 'Updated' : 'Installed'} skills/${skillName}`);

  // 2. Sync to motion/clawspace/dispatch-skills/{skillName}/
  const motionDir = path.join(root, '.clawforum', 'motion');
  const destDispatch = path.join(motionDir, CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName);
  const motionFs = deps.fsFactory(motionDir);
  const dispatchExists = motionFs.existsSync(path.join(CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName));
  await copyDir(deps, absSource, destDispatch);
  console.log(`${dispatchExists ? 'Updated' : 'Synced'} dispatch-skills/${skillName}`);
}

/**
 * Internal mode: install dispatch-skill to a specific claw
 * - Copy from motion/clawspace/dispatch-skills/{skillName}/
 * - To clawDir/skills/{skillName}/
 */
export async function skillInstallClawCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: ClawId, skillName: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  // Phase 537 — traversal guard for both identifier params
  if (
    typeof clawId !== 'string' || clawId === '' || clawId === '.' || clawId.startsWith('.') ||
    clawId.includes('/') || clawId.includes('..')
  ) {
    throw new CliError(`Invalid claw id: ${JSON.stringify(clawId)}`);
  }
  if (
    typeof skillName !== 'string' || skillName === '' || skillName === '.' || skillName.startsWith('.') ||
    skillName.includes('/') || skillName.includes('..')
  ) {
    throw new CliError(`Invalid skill name: ${JSON.stringify(skillName)}`);
  }

  const root = getWorkspaceRoot();
  const motionDir = path.join(root, '.clawforum', 'motion');
  const source = path.join(motionDir, CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName);
  const clawDir = getClawDir(clawId);
  const dest = path.join(clawDir, SKILLS_DIR_DEFAULT, skillName);

  const motionFs = deps.fsFactory(motionDir);
  if (!motionFs.existsSync(path.join(CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName))) {
    throw new CliError(`dispatch-skill "${skillName}" not found`);
  }
  const clawFs = deps.fsFactory(clawDir);
  if (!clawFs.existsSync('.')) {
    throw new CliError(`claw "${clawId}" does not exist`);
  }

  await copyDir(deps, source, dest);
  audit?.write(CLI_AUDIT_EVENTS.SKILL_INSTALL, `mode=claw`, `claw=${clawId}`, `skill=${skillName}`);
  console.log(`Installed ${skillName} to claw ${clawId}`);
}
