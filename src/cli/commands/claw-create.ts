/**
 * @module L6.CLI.Claw.Create
 */

import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { initializeClawLayout, ClawConfigAlreadyExistsError } from '../../assembly/index.js';
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

  // Friendly pre-check（诊断用；创建权由下方 saveClawExclusive O_EXCL 裁决）
  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) !== undefined) {
    throw new CliError(`Claw "${name}" already exists`);
  }

  const clawDir = getClawDir(name);
  const fileSystem = deps.fsFactory(clawDir);

  // Phase 1910 Step E（RACE-CLAW-CREATE-CHECK-THEN-CREATE）：先 materialize
  // 冪等同内容（layout + AGENTS.md 模板），再以 claw config 的 O_EXCL 独占写
  // 作为创建发布提交点 —— 同名并发 create 只有一个 winner；loser 不覆盖、
  // 不报成功。崩溃窗口（config 未发布）由下次 create 自愈重建（同内容冪等）。
  initializeClawLayout(fileSystem);
  fileSystem.writeAtomicSync(CLAW_SPEC_FILE, buildAgentsMdTemplate(name));

  // Create claw config (inherits from global) —— 独占发布提交
  const config = {
    name,
    tool_profile: 'full' as const,
    max_concurrent_tasks: 3,
  };
  try {
    deps.rootConfig.saveClawExclusive(configPath, config);
  } catch (err) {
    if (err instanceof ClawConfigAlreadyExistsError) {
      throw new CliError(`Claw "${name}" already exists`);
    }
    throw err;
  }

  audit?.write(CLI_AUDIT_EVENTS.CLAW_CREATE, `name=${name}`);
  console.log(`✓ Created Claw "${name}"`);
  console.log(`  Location: ${clawDir}`);
  console.log(`\nNext step: chestnut claw ${name} chat`);
}
