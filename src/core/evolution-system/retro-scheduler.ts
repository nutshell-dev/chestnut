/**
 * @module L4.EvolutionSystem
 * RetroScheduler port — retro 调度抽象（phase411 物理迁自 contract/）。
 *
 * 内化 A.3+A.4+A.5（phase364）：
 * - buildRetroPrompt（A.3 / from prompts/retrospective）
 * - writePendingSubagentTaskFile（A.4 / from task/tools/_pending-task-writer）
 * - createSkillRegistry（A.5 / from core/skill）
 */

import { buildRetroPrompt } from '../../prompts/retrospective.js';
import { writePendingSubagentTaskFile } from '../task/tools/_pending-task-writer.js';
import { createSkillRegistry } from '../skill/index.js';
import { DISPATCH_SKILLS_PATH as DISPATCH_SKILLS_DIR } from './dispatch-skills-paths.js';
import { DEFAULT_MAX_STEPS, DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../constants.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Message } from '../../types/message.js';
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
}

export interface RetroScheduler {
  schedule(config: RetroConfig): Promise<void>;
}

export function createDefaultRetroScheduler(): RetroScheduler {
  return {
    async schedule(config: RetroConfig): Promise<void> {
      // 加载 dispatch-skills（A.5 / best-effort）
      let skillsSummary = '';
      try {
        const reg = createSkillRegistry(config.motionFs, DISPATCH_SKILLS_DIR);
        await reg.loadAll();
        const formatted = reg.formatForContext();
        if (!formatted.includes('No skills loaded')) {
          skillsSummary = formatted;
        }
      } catch (e) {
        config.audit.write(RETRO_AUDIT_EVENTS.SKILL_FAILED,
          `err=${e instanceof Error ? e.message : String(e)}`);
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
        prompt: '',
        messages: retroMessages,
        tools: ['read', 'write', 'skill', 'exec'],
        timeout: 600,
        maxSteps: DEFAULT_MAX_STEPS,
        idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
        parentClawId: 'motion',
        originClawId: 'motion',
      });
    }
  };
}
