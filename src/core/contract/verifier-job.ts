/**
 * @module L4.ContractSystem.VerifierJob
 * Run contract verification verifier subagent — 自由函数 / 0 class state 依赖
 *
 * Migrated from manager.ts:_runVerifierSubagent (phase 427 内联后 / phase 480 抽出)
 * phase 750: 改调 runSubagent helper、删 NoopWriter + audit/stream/workspace 自治模板
 */

import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";

import { runSubagent as defaultRunSubagent } from '../subagent/index.js';

import {
  emitContractVerifierSkipped,
  emitContractVerifierFailed,
  emitContractVerifierStarted,
  emitContractVerifierPassed,
  emitContractVerifierResultParseFailed,
} from './audit-emit.js';
import { CONTRACT_ACTIVE_DIR, PROGRESS_FILE } from './dirs.js';
import { ContractProgressPersistedSchema } from './schemas.js';
import * as path from 'path';
import { createDoneTool, DONE_TOOL_NAME } from '../subagent/index.js';
import { createToolRegistry } from '../../foundation/tools/index.js';
import { ToolTimeoutError } from '../../foundation/tools/errors.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../subagent/index.js';
import { TASKS_SUBAGENTS_DIR } from '../subagent/index.js';
// phase 691 Step C: deep import dirs.ts leaf (避 barrel 触发 contract↔async-task 已有 type 链 cycle)
import { TASKS_SYNC_DIR } from '../async-task-system/dirs.js';
import { callerTypeToProfile } from '../permissions/caller-types.js';
import { buildSubagentSystemPrompt, CONTRACT_VERIFIER_SYSTEM_PROMPT } from '../../templates/prompts/index.js';
import type { VerifierConfig, VerifierResult } from './types.js';

export async function runContractVerifier(config: VerifierConfig): Promise<VerifierResult> {
  // phase 19 Step D: explicit runtime check replaces non-null assertion (LSP/M#4).
  // Assembler is expected to inject fsFactory; absence is a programming error in the
  // ContractSystem assembly path, not a runtime fallback case.
  if (!config.fsFactory) {
    throw new Error(
      'runContractVerifier: config.fsFactory is required but not injected. ' +
      'This is a programming error in the ContractSystem assembly path. ' +
      `contractId=${config.contractId}, agentId=${config.agentId}`,
    );
  }

  // Phase 1132 Step E: verifier preflight — active progress exists + strict schema.
  // The only runnable contract is one still in active/ with a valid current schema.
  // ENOENT => contract archived/moved => fail-closed.
  // Schema invalid => don't burn LLM tokens on corrupt state.
  // No lifecycle status literals are consulted; they are no longer persisted.
  if (config.contractId) {
    const progressPath = path.join(CONTRACT_ACTIVE_DIR, config.contractId, PROGRESS_FILE);
    try {
      const raw = await config.fs.read(progressPath);
      const rawParsed: unknown = JSON.parse(raw);
      const result = ContractProgressPersistedSchema.safeParse(rawParsed);
      if (!result.success) {
        if (config.audit) {
          emitContractVerifierSkipped(config.audit, {
            contractId: config.contractId, agentId: config.agentId,
            reason: 'progress_schema_invalid',
          });
        }
        return { passed: false, feedback: 'Contract progress.json schema invalid — verifier aborting' };
      }
    } catch (err) {
      if (isFileNotFound(err)) {
        if (config.audit) {
          emitContractVerifierSkipped(
            config.audit,
            { contractId: config.contractId, agentId: config.agentId, reason: 'contract_no_longer_active' },
          );
        }
        return { passed: false, feedback: 'Contract is no longer in active/ — skipping verifier' };
      }
      // EACCES, EIO, etc. → cannot determine state. Fail-closed.
      if (config.audit) {
        emitContractVerifierFailed(config.audit, {
          contractId: config.contractId, agentId: config.agentId, clawId: config.clawId,
          kind: 'io_error',
          reason: formatErr(err),
        });
      }
      return { passed: false, feedback: `Cannot read contract progress: ${formatErr(err)}` };
    }
  }

  if (config.audit) {
    emitContractVerifierStarted(
      config.audit,
      { contractId: config.contractId, agentId: config.agentId, clawId: config.clawId },
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
    const subagentImpl = config.runSubagent ?? defaultRunSubagent;
    const { text, capturedResult } = await subagentImpl({
      agentId: config.agentId,
      toolProfile: callerTypeToProfile('verifier'),
      clawDir: config.clawDir,
      fs: config.fs,
      fsFactory: config.fsFactory,
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
      syncDir: path.join(config.clawDir, TASKS_SYNC_DIR),
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
          const parsed: unknown = JSON.parse(doneResult.result);
          // phase 21: inline schema check 防 corrupt JSON 流入业务（playbook 静默失败 §8）
          if (!isValidVerifierResult(parsed)) {
            if (config.audit) {
              emitContractVerifierResultParseFailed(
                config.audit,
                {
                  contractId: config.contractId,
                  agentId: config.agentId,
                  clawId: config.clawId,
                  stage: 'done_result_schema_invalid',
                  reason: `raw=${config.audit.message(doneResult.result)}`,
                },
              );
            }
            // fall through to legacy format check (line ~152) per phase 1133 intent
          } else {
            const r = parsed;
            if (r.passed && config.audit) {
              emitContractVerifierPassed(config.audit, { contractId: config.contractId, agentId: config.agentId });
            }
            return {
              passed: r.passed,
              feedback: doneResult.result,
              structured: r,
            };
          }
        } catch (parseErr) {
          // phase 1133 (r126 C fork C-3): emit audit before fall-through to text JSON parsing below
          // 保留 fall-through intent / 但 parse 失败信息不再 silent（DP「不丢弃静默」）
          if (config.audit) {
            emitContractVerifierResultParseFailed(
              config.audit,
              {
                contractId: config.contractId,
                agentId: config.agentId,
                clawId: config.clawId,
                stage: 'done_result_first_parse',
                reason: formatErr(parseErr),
              },
            );
          }
        }
      }

      // Phase 962: unified validation — all result entry points use the same schema check
      if (isValidVerifierResult(capturedResult)) {
        const r = capturedResult;
        if (r.passed && config.audit) {
          emitContractVerifierPassed(config.audit, { contractId: config.contractId, agentId: config.agentId });
        }
        return {
          passed: r.passed,
          feedback: JSON.stringify(r),
          structured: r,
        };
      }
      // Falls through to next parsing attempt
    }

    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { passed: false, feedback: `LLM 返回格式错误: 无法解析 JSON — ${text}` };
    }
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsedText: unknown = JSON.parse(jsonStr);
    // phase 21: inline schema check 防 corrupt JSON 流入业务（playbook 静默失败 §8）
    if (!isValidVerifierResult(parsedText)) {
      if (config.audit) {
        emitContractVerifierResultParseFailed(
          config.audit,
          {
            contractId: config.contractId,
            agentId: config.agentId,
            clawId: config.clawId,
            stage: 'text_json_schema_invalid',
            reason: `raw=${config.audit.message(jsonStr)}`,
          },
        );
      }
      return { passed: false, feedback: `verifier result schema invalid: ${jsonStr}` };
    }
    const result = parsedText;
    if (result.passed && config.audit) {
      emitContractVerifierPassed(config.audit, { contractId: config.contractId, agentId: config.agentId });
    }
    return { passed: result.passed, feedback: jsonStr, structured: result };

  } catch (err) {
    // Phase 962: signal abort is not a verification failure.
    // Don't consume retry budget — propagate so the pipeline can handle cancellation.
    if (config.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    // phase 993 D.2: catch audit emit (config.audit phase 646 ⚓ inject、之前 dead field)
    if (err instanceof ToolTimeoutError) {
      emitContractVerifierFailed(
        config.audit,
        {
          contractId: config.contractId,
          agentId: config.agentId,
          clawId: config.clawId,
          kind: 'timeout',
        },
      );
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = formatErr(err);
    emitContractVerifierFailed(
      config.audit,
      {
        contractId: config.contractId,
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

// phase 21: verifier 结果 schema check（playbook 静默失败 §8）
function isValidVerifierResult(
  x: unknown,
): x is { passed: boolean; reason: string; issues?: string[] } {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { passed?: unknown; reason?: unknown; issues?: unknown };
  if (typeof o.passed !== 'boolean') return false;
  if (typeof o.reason !== 'string') return false;
  if (o.issues !== undefined) {
    if (!Array.isArray(o.issues)) return false;
    if (!o.issues.every((s: unknown) => typeof s === 'string')) return false;
  }
  return true;
}
