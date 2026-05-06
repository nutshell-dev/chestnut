/**
 * @module L4.ContractSystem.VerifierJob
 * Run contract acceptance verifier subagent — 自由函数 / 0 class state 依赖
 *
 * Migrated from manager.ts:_runVerifierSubagent (phase 427 内联后 / phase 480 抽出)
 */

import { createSubAgent, NoopStreamWriter, NoopAuditWriter } from '../subagent/index.js';
import * as path from 'path';
import { createDialogStore } from '../../foundation/dialog-store/index.js';
import { ReportResultTool } from '../../foundation/tools/report-result.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { ToolTimeoutError } from '../../types/errors.js';
import { TASKS_SYNC_SPAWN_DIR, TASKS_SUBAGENTS_DIR } from '../../types/paths.js';
import { buildSubagentSystemPromptPrefix, CONTRACT_VERIFIER_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import type { VerifierConfig, VerifierResult } from './types.js';

export async function runContractVerifier(config: VerifierConfig): Promise<VerifierResult> {
  try {
    const reportTool = new ReportResultTool();
    const registry = createToolRegistry();
    registry.register(reportTool);

    // phase 512: per-subagent workspace dir
    const verifierWorkspaceDir = path.join(config.clawDir, TASKS_SUBAGENTS_DIR, config.agentId);
    await config.fs.ensureDir(verifierWorkspaceDir);
    const promptPrefix = buildSubagentSystemPromptPrefix({
      taskId: config.agentId,
      callerClawId: config.clawId,
    });

    const agent = createSubAgent({
      agentId: config.agentId,
      resultDir: `${TASKS_SYNC_SPAWN_DIR}/${config.agentId}`,
      messageStore: createDialogStore(
        config.fs as any,
        `${TASKS_SYNC_SPAWN_DIR}/${config.agentId}`,
        new NoopAuditWriter(),
        'messages.json',
        CONTRACT_VERIFIER_SYSTEM_PROMPT,
      ),
      prompt: config.prompt,
      clawDir: config.clawDir,
      syncDir: path.join(config.clawDir, 'tasks', 'sync'),
      llm: config.llm,
      registry,
      fs: config.fs as any,
      maxSteps: config.maxSteps,
      idleTimeoutMs: config.idleTimeoutMs,
      onIdleTimeout: config.onIdleTimeout,
      systemPrompt: `${promptPrefix}\n\n${CONTRACT_VERIFIER_SYSTEM_PROMPT}`,  // phase 512
      workspaceDir: verifierWorkspaceDir,    // phase 512
      callerClawId: config.clawId,           // phase 514
      taskStreamWriter: new NoopStreamWriter(),
      auditWriter: new NoopAuditWriter(),
    });

    const text = await agent.run();

    if (reportTool.capturedResult) {
      return {
        passed: reportTool.capturedResult.passed,
        feedback: JSON.stringify(reportTool.capturedResult),
        structured: reportTool.capturedResult,
      };
    }

    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { passed: false, feedback: `LLM 返回格式错误: 无法解析 JSON — ${text}` };
    }
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const result = JSON.parse(jsonStr) as { passed: boolean; reason: string; issues?: string[] };
    return { passed: result.passed, feedback: jsonStr, structured: result };
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, feedback: `LLM 验收失败: ${msg}` };
  }
}
