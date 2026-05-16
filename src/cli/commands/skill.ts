/**
 * Skill install commands
 *
 * User mode: install skill from local path to workspace
 * Internal mode: install dispatch-skill to a specific claw
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import { CLAWSPACE_DIR } from '../../types/paths.js';
import { SKILLS_DIR_DEFAULT } from '../../foundation/skill-system/skill-paths.js';
import { DISPATCH_SKILLS_SUBDIR } from '../../core/evolution-system/index.js';
import { getClawDir } from '../../foundation/config/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { getWorkspaceRoot } from '../../foundation/config/paths.js';
import { CliError } from '../errors.js';

/**
 * Copy directory recursively
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * User mode: install skill from local path to workspace
 * - Copy to root/skills/{skillName}/
 * - Sync to motion/clawspace/dispatch-skills/{skillName}/
 */
export async function skillInstallUserCommand(sourcePath: string, deps?: { audit?: AuditLog }): Promise<void> {
  const audit = deps?.audit;
  const root = getWorkspaceRoot();
  const absSource = path.resolve(sourcePath);

  // Skill name = source directory name
  const skillName = path.basename(absSource);

  // Verify SKILL.md exists
  const skillMd = path.join(absSource, 'SKILL.md');
  if (!fsNative.existsSync(skillMd)) {
    throw new CliError(`No SKILL.md found in ${absSource}`);
  }

  // 1. Copy to root level skills/{skillName}/
  const destUser = path.join(root, SKILLS_DIR_DEFAULT, skillName);
  const userExists = fsNative.existsSync(destUser);
  await copyDir(absSource, destUser);
  audit?.write(CLI_AUDIT_EVENTS.SKILL_INSTALL, `mode=user`, `skill=${skillName}`);
  console.log(`${userExists ? 'Updated' : 'Installed'} skills/${skillName}`);

  // 2. Sync to motion/clawspace/dispatch-skills/{skillName}/
  const motionDir = path.join(root, '.clawforum', 'motion');
  const destDispatch = path.join(motionDir, CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName);
  const dispatchExists = fsNative.existsSync(destDispatch);
  await copyDir(absSource, destDispatch);
  console.log(`${dispatchExists ? 'Updated' : 'Synced'} dispatch-skills/${skillName}`);
}

/**
 * Internal mode: install dispatch-skill to a specific claw
 * - Copy from motion/clawspace/dispatch-skills/{skillName}/
 * - To clawDir/skills/{skillName}/
 */
export async function skillInstallClawCommand(clawId: string, skillName: string, deps?: { audit?: AuditLog }): Promise<void> {
  const audit = deps?.audit;
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

  if (!fsNative.existsSync(source)) {
    throw new CliError(`dispatch-skill "${skillName}" not found`);
  }
  if (!fsNative.existsSync(clawDir)) {
    throw new CliError(`claw "${clawId}" does not exist`);
  }

  await copyDir(source, dest);
  audit?.write(CLI_AUDIT_EVENTS.SKILL_INSTALL, `mode=claw`, `claw=${clawId}`, `skill=${skillName}`);
  console.log(`Installed ${skillName} to claw ${clawId}`);
}
