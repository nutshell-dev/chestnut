/**
 * @module L4.ContractSystem.VerifierJob
 * Run contract acceptance verifier subagent — 自由函数 / 0 class state 依赖
 *
 * Migrated from manager.ts:_runVerifierSubagent (phase 427 内联后 / phase 480 抽出)
 * phase 750: 改调 runSubagent helper、删 NoopWriter + audit/stream/workspace 自治模板
 */

import { runSubagent } from '../subagent/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import {
  emitContractVerifierSkipped,
  emitContractVerifierFailed,
  emitContractVerifierStarted,
  emitContractVerifierPassed,
  emitContractVerifierResultParseFailed,
} from './audit-emit.js';
import { CONTRACT_ACTIVE_DIR } from './dirs.js';
import * as path from 'path';
import { createDoneTool, DONE_TOOL_NAME } from '../subagent/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { ToolTimeoutError } from '../../foundation/errors.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../subagent/index.js';
import { TASKS_SUBAGENTS_DIR } from '../subagent/constants.js';
import { buildSubagentSystemPrompt, CONTRACT_VERIFIER_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import type { VerifierConfig, VerifierResult } from './types.js';

export async function runContractVerifier(config: VerifierConfig): Promise<VerifierResult> {
  // phase 1080: crash-recovery — skip verifier if contract was cancelled
  if (config.contractId) {
    const progressPath = path.join(
      CONTRACT_ACTIVE_DIR,
      config.contractId,
      'progress.json',
    );
    try {
      const raw = await config.fs.read(progressPath);
      const progress = JSON.parse(raw) as { status?: string };
      if (progress.status === 'cancelled') {
        if (config.audit) {
          emitContractVerifierSkipped(
            config.audit,
            { agentId: config.agentId, reason: 'contract_cancelled' },
          );
        }
        return { passed: false, feedback: 'Contract was cancelled before verifier started' };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (config.audit) {
          emitContractVerifierFailed(
            config.audit,
            {
              agentId: config.agentId,
              clawId: config.clawId,
              kind: 'progress_read_error',
              reason: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      // ENOENT or other read error: do not block verifier
    }
  }

  if (config.audit) {
    emitContractVerifierStarted(
      config.audit,
      { agentId: config.agentId, clawId: config.clawId },
    );
  }

  try {
    const doneTool = createDoneTool();
    const registry = createToolRegistry();

    // phase 704: 注入 readonly profile 工具子集（read+ls+search+status+memory_search）
    // 与 CONTRACT_VERIFIER_SYSTEM_PROMPT 指令「Use the available tools (read, ls, search) to inspect」align
    // M#7 耦合界面稳定 / M#5 单向依赖（L4 借用 L2 toolRegistry / 不自建）
    for (const tool of config.toolRegistry.getForProfile('readonly')) {
      registry.register(tool);
    }

    registry.register(doneTool);

    // 调 runSubagent helper（替代 createSubAgent + 自治 audit/stream/workspace）
    const { text, capturedResult } = await runSubagent({
      agentId: config.agentId,
      callerType: 'verifier',
      clawDir: config.clawDir,
      fs: config.fs,
      fsFactory: config.fsFactory!,
      llm: config.llm,
      registry,
      prompt: config.prompt,
      systemPrompt: buildSubagentSystemPrompt({
        taskId: config.agentId,
        callerClawId: config.clawId,
        subagentsDir: TASKS_SUBAGENTS_DIR,
        systemPrompt: CONTRACT_VERIFIER_SYSTEM_PROMPT,
      }),
      resultDir: `${TASKS_SYNC_SUBAGENT_DIR}/${config.agentId}`,
      maxSteps: config.maxSteps,
      idleTimeoutMs: config.idleTimeoutMs,
      onIdleTimeout: config.onIdleTimeout,
      resultTool: DONE_TOOL_NAME,
      signal: config.signal,   // phase 993 D.1: cancel chain propagation
      toolTimeoutMs: config.toolTimeoutMs, // phase 1029 / F-2
    });

    // 结果解析（既有 fallback 逻辑保留）
    // phase 1056: done tool 返回 { result: string }，需先解析 result 字段中的 JSON
    if (capturedResult && typeof capturedResult === 'object') {
      const doneResult = capturedResult as { result?: string };
      if (doneResult.result) {
        try {
          const r = JSON.parse(doneResult.result) as { passed: boolean; reason: string; issues?: string[] };
          if (r.passed && config.audit) {
            emitContractVerifierPassed(config.audit, { agentId: config.agentId });
          }
          return {
            passed: r.passed,
            feedback: doneResult.result,
            structured: r,
          };
        } catch (parseErr) {
          // phase 1133 (r126 C fork C-3): emit audit before fall-through to text JSON parsing below
          // 保留 fall-through intent / 但 parse 失败信息不再 silent（DP「不丢弃静默」）
          if (config.audit) {
            emitContractVerifierResultParseFailed(
              config.audit,
              {
                agentId: config.agentId,
                clawId: config.clawId,
                stage: 'done_result_first_parse',
                reason: parseErr instanceof Error ? parseErr.message : String(parseErr),
              },
            );
          }
        }
      }

      // 兼容旧格式（direct object）
      const r = capturedResult as { passed: boolean; reason: string; issues?: string[] };
      if ('passed' in r) {
        if (r.passed && config.audit) {
          emitContractVerifierPassed(config.audit, { agentId: config.agentId });
        }
        return {
          passed: r.passed,
          feedback: JSON.stringify(r),
          structured: r,
        };
      }
    }

    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { passed: false, feedback: `LLM 返回格式错误: 无法解析 JSON — ${text}` };
    }
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const result = JSON.parse(jsonStr) as { passed: boolean; reason: string; issues?: string[] };
    if (result.passed && config.audit) {
      emitContractVerifierPassed(config.audit, { agentId: config.agentId });
    }
    return { passed: result.passed, feedback: jsonStr, structured: result };

  } catch (err) {
    // phase 993 D.2: catch audit emit (config.audit phase 646 ⚓ inject、之前 dead field)
    if (err instanceof ToolTimeoutError) {
      emitContractVerifierFailed(
        config.audit,
        {
          agentId: config.agentId,
          clawId: config.clawId,
          kind: 'timeout',
        },
      );
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    emitContractVerifierFailed(
      config.audit,
      {
        agentId: config.agentId,
        clawId: config.clawId,
        kind: 'other',
        reason: msg,
      },
    );
    return { passed: false, feedback: `LLM 验收失败: ${msg}` };
  }
  // 不需要 finally cleanup（runSubagent 现 0 创建 subagent workspace dir / phase 805 sub-3 闭环）
}
