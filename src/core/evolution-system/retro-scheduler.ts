/**
 * @module L4.EvolutionSystem
 * scheduleRetro — retro 调度 standalone function（phase426 port 抽象推翻 / phase411 物理迁自 contract/）。
 *
 * 内化 A.3+A.4+A.5（phase364）：
 * - buildRetroPrompt（A.3 / from prompts/retrospective）
 * - AsyncTaskSystem.schedule（phase 1332 N2 inlined / 替原 writePendingSubagentTaskFile）
 * - createSkillSystem（A.5 / from core/skill）
 */

import { buildRetroPrompt } from '../../templates/prompts/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { MOTION_CLAW_ID } from '../claw-topology/index.js';
import type { SubAgentTaskScheduler } from '../async-task-system/index.js';
import type { SubAgentTask } from '../async-task-system/index.js';
import { createSkillSystem as defaultCreateSkillSystem } from '../../foundation/skill-system/index.js';
import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from './dispatch-skills-paths.js';
// phase 1490: 不再传 maxSteps、task.maxSteps optional / undefined 透传到 SubAgent boundary fallback。
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';

/** Default retro subagent timeout (ms); 10 min by design */
/**
 * Default retroSubagentTimeoutMs (10 minutes) — used when ContractYaml 未指定.
 * Derivation: 10min × 60_000ms = 600_000ms / 给 retro reflective subagent 足够时长
 * 完成多轮 LLM call + summary 写入 / < SUBAGENT_TIMEOUT_MS (5min) × 2 防 worker hang.
 * Exported: tests/ 镜像此 default（state-file.test.ts 验 default fallback）.
 */
export const RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT = 10 * 60_000;
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import type { ContractId } from '../contract/index.js';



export interface RetroConfig {
  targetClaw: string;
  contractId: ContractId;
  contractYaml: string;
  motionFs: FileSystem;
  motionAudit: AuditLog;
  motionBaseDir: string;
  audit: AuditLog;  // claw audit (for skill failure log)
  retroSubagentTimeoutMs?: number;   // default 600000ms
  taskSystem: SubAgentTaskScheduler;
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

interface RetroSubagentPayloadInput {
  targetClaw: string;
  contractId: ContractId;
  contractYaml: string;
  motionFs: FileSystem;
  audit: AuditLog;
  retroSubagentTimeoutMs?: number;
  createSkillSystem?: typeof defaultCreateSkillSystem;
}

/**
 * Build the canonical retro subagent payload (without identity fields).
 * Shared between legacy schedule() and Phase 1206 prepared identity submission.
 */
export async function buildRetroSubagentPayload(
  input: RetroSubagentPayloadInput,
): Promise<Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>> {
  // 加载 dispatch-skills（A.5 / best-effort）
  let skillsSummary = '';
  try {
    const createSkillFn = input.createSkillSystem ?? defaultCreateSkillSystem;
    const reg = createSkillFn(input.motionFs, DISPATCH_SKILLS_DIR, input.audit);
    await reg.loadAll();
    const formatted = reg.formatForContext();
    if (!formatted.includes('No skills loaded')) {
      skillsSummary = formatted;
    }
  } catch (e) {
    input.audit.write(RETRO_AUDIT_EVENTS.SKILL_FAILED,
      `error=${formatErr(e)}`);
  }

  // 构建 retroPrompt（A.3）
  const retroPrompt = buildRetroPrompt(
    input.targetClaw, input.contractId, input.contractYaml, skillsSummary
  );

  return {
    kind: 'subagent',
    mode: 'standard',
    intent: retroPrompt,
    timeoutMs: input.retroSubagentTimeoutMs ?? RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT,
    // phase 1490: maxSteps 不传、task.maxSteps optional / undefined → SubAgent boundary fallback
    parentClawId: MOTION_CLAW_ID,
    originClawId: MOTION_CLAW_ID,
    toolProfile: 'subagent',
  };
}

/**
 * scheduleRetro
 *
 * 输入：RetroConfig（targetClaw / contractId / contractYaml / motionFs / motionAudit / motionBaseDir / audit）
 * 输出：Promise<void>
 * 边界：1:1 保留原 schedule body / 仅删 port abstraction wrapper
 */
export async function scheduleRetro(config: RetroConfig): Promise<void> {
  const payload = await buildRetroSubagentPayload({
    targetClaw: config.targetClaw,
    contractId: config.contractId,
    contractYaml: config.contractYaml,
    motionFs: config.motionFs,
    audit: config.audit,
    retroSubagentTimeoutMs: config.retroSubagentTimeoutMs,
    createSkillSystem: config.createSkillSystem,
  });
  await config.taskSystem.schedule('subagent', payload);
}
