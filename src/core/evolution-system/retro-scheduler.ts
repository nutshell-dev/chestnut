/**
 * @module L4.EvolutionSystem
 * scheduleRetro — retro 调度 standalone function（phase426 port 抽象推翻 / phase411 物理迁自 contract/）。
 *
 * 内化 A.3+A.4+A.5（phase364）：
 * - buildRetroPrompt（A.3 / from prompts/retrospective）
 * - AsyncTaskSystem.schedule（phase 1332 N2 inlined / 替原 writePendingSubagentTaskFile）
 * - createSkillSystem（A.5 / from core/skill）
 */

import {
  buildRetroPrompt,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  SUBAGENT_WORKSPACE_PROMPT_TEMPLATE,
} from '../../templates/prompts/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import { MOTION_CLAW_ID } from '../claw-topology/index.js';
import type { SubAgentTaskScheduler } from '../async-task-system/index.js';
import type { SubAgentTask } from '../async-task-system/index.js';
import type { SkillVersions } from '../../foundation/skill-system/index.js';
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
import {
  TASKS_SUBAGENTS_DIR,
  type PreparedSubagentInput,
  type SubagentInputDeclaration,
} from '../subagent/index.js';



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
  /** Constructor-bound SubAgent preparation; there is no legacy Assembly fallback. */
  prepareSubagentInput: PrepareRetroSubagentInput;
  /**
   * Phase 1919 Step B：dispatch 技能摘要唯一来源 = 版本服务固定版本读取。
   * 未注入（非 Motion 装配/测试窄 fixture）= 无摘要，绝不回退 live 目录扫描。
   */
  skillVersions?: SkillVersions;
}

/** Fixed SubAgent preparation capability; the bound implementation supplies canonical tools. */
export type PrepareRetroSubagentInput = (
  declaration: Omit<SubagentInputDeclaration, 'tools'>,
) => PreparedSubagentInput;

interface RetroSubagentPayloadInput {
  targetClaw: string;
  contractId: ContractId;
  contractYaml: string;
  motionFs: FileSystem;
  audit: AuditLog;
  retroSubagentTimeoutMs?: number;
  skillVersions?: SkillVersions;
  prepareSubagentInput: PrepareRetroSubagentInput;
}

/**
 * Build the canonical retro subagent payload (without identity fields).
 * Shared between legacy schedule() and Phase 1206 prepared identity submission.
 */
export async function buildRetroSubagentPayload(
  input: RetroSubagentPayloadInput,
): Promise<Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>> {
  // 加载 dispatch-skills 摘要（Phase 1919 Step B：committed view 唯一入口 / best-effort）
  let skillsSummary = '';
  if (input.skillVersions) {
    try {
      const formatted = await input.skillVersions.formatPublishedForContext();
      if (!formatted.includes('No skills loaded')) {
        skillsSummary = formatted;
      }
    } catch (e) {
      input.audit.write(RETRO_AUDIT_EVENTS.SKILL_FAILED,
        `error=${formatErr(e)}`);
    }
  }

  // 构建 retroPrompt（A.3）
  const retroPrompt = buildRetroPrompt(
    input.targetClaw, input.contractId, input.contractYaml, skillsSummary
  );

  const timeoutMs = input.retroSubagentTimeoutMs ?? RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT;
  const executionInput = input.prepareSubagentInput({
    prompt: retroPrompt,
    systemPrompt: {
      kind: 'template',
      template: SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.name,
      version: SUBAGENT_WORKSPACE_PROMPT_TEMPLATE.version,
      parameters: {
        callerClawId: MOTION_CLAW_ID,
        subagentsDir: TASKS_SUBAGENTS_DIR,
        systemPrompt: DEFAULT_SUBAGENT_SYSTEM_PROMPT,
      },
    },
    toolProfile: 'subagent',
    budget: { timeoutMs },
  });

  return {
    kind: 'subagent',
    mode: 'standard',
    intent: retroPrompt,
    // Phase 1919 Step D：持久复盘来源引用（correlation = ATS opaque 来源事实）。
    // 复盘子代理编辑 dispatch 技能时经 CHESTNUT_SUBAGENT_TASK_ID + owner 窄查询
    // （loadSubAgentTask）解析回本任务与本 contract，依据可追溯、不伪造。
    correlation: { source: 'retro', ref: input.contractId },
    timeoutMs,
    executionInput: { schema_version: 1, input: executionInput },
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
    skillVersions: config.skillVersions,
    prepareSubagentInput: config.prepareSubagentInput,
  });
  await config.taskSystem.schedule('subagent', payload);
}
