/**
 * Contract Verifier Scheduler
 *
 * Port abstraction for ContractSystem's verifier subagent scheduling.
 * 消费方 (ContractSystem) own / 装配方注入实现（per Meta 29 §port 消费方 own）。
 *
 * Default impl `createSubAgentVerifierScheduler`：
 * - 包装现有 createSubAgent + ReportResultTool 逻辑（同步等结果 / 行为 0 改）
 * - phase340 立 port + 删 ContractSystem 4 处 L2/L3 直 import
 *
 * H6 异步化 (verifier 走 TaskSystem dispatch 通道) = design-gap (应然 silent on
 * verifier sync vs async / acceptance state machine sync 反馈 可能合理业务)
 * → 推 r41+ design 评估 / 不在本 phase 强行 mechanical 异步化。
 * design-gap 登记：design/modules/l4_contract_system.md §7.B B.p340-1。
 */

import type { LLMService } from '../../foundation/llm/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ToolRegistry } from '../tools/executor.js';
import { createSubAgent, NoopStreamWriter, NoopAuditWriter } from '../subagent/index.js';
import { ReportResultTool } from '../tools/report-result.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import { ToolTimeoutError } from '../../types/errors.js';

export interface VerifierConfig {
  agentId: string;
  prompt: string;
  systemPrompt: string;
  clawDir: string;
  llm: LLMService;
  registry: ToolRegistry;
  fs: FileSystem;
  maxSteps: number;
  idleTimeoutMs: number;
  onIdleTimeout?: () => void;
}

export interface VerifierResult {
  passed: boolean;
  feedback: string;
  structured?: { passed: boolean; reason: string; issues?: string[] };
}

export interface ContractVerifierScheduler {
  /**
   * Schedule verifier subagent execution.
   *
   * Default sync impl: wraps createSubAgent + ReportResultTool.
   * Future async impl (H6 完整): dispatch via TaskSystem (推 r41+ design 评估).
   */
  schedule(config: VerifierConfig): Promise<VerifierResult>;
}

/**
 * Default sync implementation.
 *
 * Wraps existing createSubAgent + ReportResultTool capture pattern
 * (extracted from manager.ts L1177-1238 / 行为 0 改).
 */
export function createSubAgentVerifierScheduler(): ContractVerifierScheduler {
  return {
    async schedule(config: VerifierConfig): Promise<VerifierResult> {
      try {
        // Build registry: caller-provided tools + report_result tool
        const reportTool = new ReportResultTool();
        const registry = new ToolRegistryImpl();
        for (const t of config.registry.getAll()) {
          registry.register(t);
        }
        registry.register(reportTool);

        // Create SubAgent
        const agent = createSubAgent({
          agentId: config.agentId,
          prompt: config.prompt,
          clawDir: config.clawDir,
          llm: config.llm,
          registry,
          fs: config.fs as any,
          maxSteps: config.maxSteps,
          idleTimeoutMs: config.idleTimeoutMs,
          onIdleTimeout: config.onIdleTimeout,
          systemPrompt: config.systemPrompt,
          taskStreamWriter: new NoopStreamWriter(),
          auditWriter: new NoopAuditWriter(),
        });

        // Run
        const text = await agent.run();

        // Prefer structured tool result
        if (reportTool.capturedResult) {
          return {
            passed: reportTool.capturedResult.passed,
            feedback: JSON.stringify(reportTool.capturedResult),
            structured: reportTool.capturedResult,
          };
        }

        // Fallback: text-based JSON parsing
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
    },
  };
}
