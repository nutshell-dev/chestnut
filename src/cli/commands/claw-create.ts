/**
 * @module L6.CLI.Claw.Create
 */

import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import {
  ClawConfigAlreadyExistsError,
  makeClawCreationIntent,
  claimClawCreation,
  materializeClawCreation,
  completeClawCreation,
} from '../../assembly/index.js';
import { CliError } from '../errors.js';
import { buildAgentsMdTemplate } from '../../templates/prompts/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import type { ClawCreateCommandDeps } from './claw-command-deps.js';

export async function createCommand(deps: ClawCreateCommandDeps, name: string, opts?: { audit?: AuditLog }): Promise<void> {
  const audit = opts?.audit;
  // Load global config (ensures initialized)
  deps.rootConfig.loadGlobal();

  // Friendly pre-check（诊断用 + legacy 已发布 claw 只读拒绝；创建权由下方 claim 裁决）
  const configPath = getClawConfigPath(name);
  if (deps.rootConfig.loadClaw(configPath) !== undefined) {
    throw new CliError(`Claw "${name}" already exists`);
  }

  const clawDir = getClawDir(name);
  const template = buildAgentsMdTemplate(name);
  const config = {
    name,
    tool_profile: 'full' as const,
    max_concurrent_tasks: 3,
  };

  // Phase 1911 Step H（RACE-CLAW-CREATE-PREMATERIALIZE）：先取得创建权（稳定
  // claim/intent，owner capability 归 Assembly），后物化（layout 幂等 + 模板
  // staging 完整落盘 + hard-link 不可替换发布），最后以 claw config 的 O_EXCL
  // 独占写作为发布提交点。迟到 loser 在任何阶段都不覆盖 winner/用户字节：
  // 模板发布 no-replace、config O_EXCL；同名并发恰一 winner；claim-only crash
  // 由同 intent 重放恢复，异 intent/坏 claim fail-closed 留证。
  const intent = makeClawCreationIntent(name, template, config);
  const claim = claimClawCreation({ fsFactory: deps.fsFactory }, clawDir, intent);
  if (claim.kind === 'conflict') {
    throw new CliError(
      `Claw "${name}" creation was interrupted or is in progress with a different intent (${claim.detail}); evidence preserved under ${clawDir}`,
    );
  }

  materializeClawCreation({ fsFactory: deps.fsFactory }, clawDir, template);

  // Create claw config (inherits from global) —— 独占发布提交
  try {
    deps.rootConfig.saveClawExclusive(configPath, config);
  } catch (err) {
    if (err instanceof ClawConfigAlreadyExistsError) {
      // 迟到 loser：winner 已发布 → claim 失去意义，顺手清理；不误报成功
      completeClawCreation({ fsFactory: deps.fsFactory }, clawDir);
      throw new CliError(`Claw "${name}" already exists`);
    }
    throw err;
  }
  completeClawCreation({ fsFactory: deps.fsFactory }, clawDir);

  audit?.write(CLI_AUDIT_EVENTS.CLAW_CREATE, `name=${name}`);
  console.log(`✓ Created Claw "${name}"`);
  console.log(`  Location: ${clawDir}`);
  console.log(`\nNext step: chestnut claw ${name} chat`);
}
