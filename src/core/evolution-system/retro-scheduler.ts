/**
 * @module L4.EvolutionSystem
 * scheduleRetro — retro 调度 standalone function（phase426 port 抽象推翻 / phase411 物理迁自 contract/）。
 *
 * 内化 A.3+A.4+A.5（phase364）：
 * - buildRetroPrompt（A.3 / from prompts/retrospective）
 * - writePendingSubagentTaskFile（A.4 / from async-task-system 公开 API / phase 763 升级）
 * - createSkillSystem（A.5 / from core/skill）
 */

import { buildRetroPrompt } from '../../prompts/retrospective.js';
import { writePendingSubagentTaskFile } from '../async-task-system/index.js';
import { createSkillSystem } from '../../foundation/skill-system/index.js';
import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from './dispatch-skills-paths.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import { DEFAULT_MAX_STEPS } from '../agent-executor/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Message } from '../../foundation/llm-provider/types.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';

export interface RetroConfig {
  targetClaw: string;
  contractId: string;
  contractYaml: string;
  motionFs: FileSystem;
  motionAudit: AuditLog;
  motionBaseDir: string;
  baseMessages: Message[];
  audit: AuditLog;  // claw audit (for skill failure log)
  retroSubagentTimeoutMs?: number;   // default 600000ms
}

/**
 * scheduleRetro
 *
 * 输入：RetroConfig（targetClaw / contractId / contractYaml / motionFs / motionAudit / motionBaseDir / baseMessages / audit）
 * 输出：Promise<void>
 * 边界：1:1 保留原 schedule body / 仅删 port abstraction wrapper
 */
export async function scheduleRetro(config: RetroConfig): Promise<void> {
  // 加载 dispatch-skills（A.5 / best-effort）
  let skillsSummary = '';
  try {
    const reg = createSkillSystem(config.motionFs, DISPATCH_SKILLS_DIR, config.audit);
    await reg.loadAll();
    const formatted = reg.formatForContext();
    if (!formatted.includes('No skills loaded')) {
      skillsSummary = formatted;
    }
  } catch (e) {
    config.audit.write(RETRO_AUDIT_EVENTS.SKILL_FAILED,
      `error=${e instanceof Error ? e.message : String(e)}`);
  }

  // 构建 retroPrompt（A.3）
  const retroPrompt = buildRetroPrompt(
    config.targetClaw, config.contractId, config.contractYaml, skillsSummary
  );
  const retroMessages: Message[] = [
    ...config.baseMessages,
    { role: 'user', content: retroPrompt },
  ];

  // 调度 retro subagent（A.4）
  await writePendingSubagentTaskFile(config.motionFs, config.motionAudit, {
    kind: 'subagent',
    intent: retroPrompt,
    timeoutMs: config.retroSubagentTimeoutMs ?? 600000,
    maxSteps: DEFAULT_MAX_STEPS,
    parentClawId: 'motion',
    originClawId: 'motion',
  });
}
