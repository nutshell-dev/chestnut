/**
 * @module L4.ContractSystem.VerifierJob
 * Run contract acceptance verifier subagent — 自由函数 / 0 class state 依赖
 *
 * Migrated from manager.ts:_runVerifierSubagent (phase 427 内联后 / phase 480 抽出)
 * phase 750: 改调 runSubagent helper、删 NoopWriter + audit/stream/workspace 自治模板
 */

import { runSubagent } from '../subagent/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { ReportResultTool, REPORT_RESULT_TOOL_NAME } from './tools/report-result.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { ToolTimeoutError } from '../../types/errors.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../subagent/index.js';
import { TASKS_SUBAGENTS_DIR } from '../async-task-system/index.js';
import { buildSubagentSystemPromptPrefix, CONTRACT_VERIFIER_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import type { VerifierConfig, VerifierResult } from './types.js';

export async function runContractVerifier(config: VerifierConfig): Promise<VerifierResult> {
  try {
    const reportTool = new ReportResultTool();
    const registry = createToolRegistry();

    // phase 704: 注入 readonly profile 工具子集（read+ls+search+status+memory_search）
    // 与 CONTRACT_VERIFIER_SYSTEM_PROMPT 指令「Use the available tools (read, ls, search) to inspect」align
    // M#7 耦合界面稳定 / M#5 单向依赖（L4 借用 L2 toolRegistry / 不自建）
    for (const tool of config.toolRegistry.getForProfile('readonly')) {
      registry.register(tool);
    }

    registry.register(reportTool);

    const promptPrefix = buildSubagentSystemPromptPrefix({
      taskId: config.agentId,
      callerClawId: config.clawId,
      subagentsDir: TASKS_SUBAGENTS_DIR,
    });

    // 调 runSubagent helper（替代 createSubAgent + 自治 audit/stream/workspace）
    const { text, capturedResult } = await runSubagent({
      agentId: config.agentId,
      callerType: 'verifier',
      callerClawId: config.clawId,
      clawDir: config.clawDir,
      fs: config.fs,
      llm: config.llm,
      registry,
      prompt: config.prompt,
      systemPrompt: `${promptPrefix}\n\n${CONTRACT_VERIFIER_SYSTEM_PROMPT}`,
      resultDir: `${TASKS_SYNC_SUBAGENT_DIR}/${config.agentId}`,
      maxSteps: config.maxSteps,
      idleTimeoutMs: config.idleTimeoutMs,
      onIdleTimeout: config.onIdleTimeout,
      resultTool: REPORT_RESULT_TOOL_NAME,
      signal: config.signal,   // phase 993 D.1: cancel chain propagation
      toolTimeoutMs: config.toolTimeoutMs, // phase 1029 / F-2
    });

    // 结果解析（既有 fallback 逻辑保留）
    if (capturedResult && typeof capturedResult === 'object') {
      const r = capturedResult as { passed: boolean; reason: string; issues?: string[] };
      return {
        passed: r.passed,
        feedback: JSON.stringify(r),
        structured: r,
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
    // phase 993 D.2: catch audit emit (config.audit phase 646 ⚓ inject、之前 dead field)
    if (err instanceof ToolTimeoutError) {
      config.audit?.write(
        CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED,
        `agentId=${config.agentId}`,
        `clawId=${config.clawId}`,
        `kind=timeout`,
      );
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    config.audit?.write(
      CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED,
      `agentId=${config.agentId}`,
      `clawId=${config.clawId}`,
      `kind=other`,
      `reason=${msg}`,
    );
    return { passed: false, feedback: `LLM 验收失败: ${msg}` };
  }
  // 不需要 finally cleanup（runSubagent 现 0 创建 subagent workspace dir / phase 805 sub-3 闭环）
}
