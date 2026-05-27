/**
 * @module L4.ContractSystem.Verification.Execution
 * Execution engine — script backend + LLM backend
 */

import * as path from 'path';
import type { VerificationContext } from './verification-types.js';
import type { VerificationResult, SubtaskId } from './types.js';
import { exec } from '../../foundation/process-exec/index.js';
import { ProcessExecError } from '../../foundation/process-exec/index.js';
import { CONTRACT_SCRIPT_TIMEOUT_MS } from './constants.js';
import { ToolTimeoutError } from '../../foundation/errors.js';
import { formatErr } from '../../foundation/utils/format.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import type { ContractId } from './types.js';
import { DEFAULT_MAX_STEPS } from '../agent-executor/index.js';
import {
  emitContractVerificationScriptStarted,
  emitContractVerificationTimeout,
} from './audit-emit.js';

export async function runScriptVerification(
  ctx: VerificationContext,
  scriptFile: string,
  contractAbsDir: string,
): Promise<VerificationResult> {
  const resolved = path.resolve(contractAbsDir, scriptFile);
  if (!resolved.startsWith(contractAbsDir + path.sep)) {
    return { passed: false, feedback: `路径安全拒绝: script_file 必须在契约目录内` };
  }
  emitContractVerificationScriptStarted(
    ctx.audit,
    { script: scriptFile, cwd: ctx.clawDir },
  );
  try {
    await exec('sh', [resolved], {
      cwd: ctx.clawDir,
      timeout: CONTRACT_SCRIPT_TIMEOUT_MS,
    });
    return { passed: true, feedback: 'Script verification passed' };
  } catch (err) {
    if (!(err instanceof ProcessExecError)) {
      return { passed: false, feedback: `验收失败: ${formatErr(err)}` };
    }
    const prefix = err.killed ? '验收脚本超时' : '验收失败';
    const detail = err.output || err.message;
    const firstLine = detail.split('\n').find(l => l.trim()) ?? detail.trim();
    return { passed: false, feedback: `${prefix}: ${firstLine}` };
  }
}

export async function runLLMVerification(
  ctx: VerificationContext,
  promptFile: string,
  contractAbsDir: string,
  contractId: ContractId,
  subtaskId: SubtaskId,
  subtaskDesc: string,
  evidence: string,
  artifacts: string[],
): Promise<VerificationResult> {
  if (!ctx.llm) {
    return { passed: false, feedback: 'LLM 验收未配置（llm 未注入）' };
  }
  const resolved = path.resolve(contractAbsDir, promptFile);
  if (!resolved.startsWith(contractAbsDir + path.sep)) {
    return { passed: false, feedback: '路径安全拒绝: prompt_file 必须在契约目录内' };
  }
  try {
    const relativePath = path.relative(ctx.clawDir, resolved);
    if (relativePath.startsWith('..')) {
      return { passed: false, feedback: '路径安全拒绝: prompt_file 解析后逃出 claw 目录' };
    }
    let promptTemplate: string;
    try {
      promptTemplate = await ctx.fs.read(relativePath);
    } catch (readErr) {
      return { passed: false, feedback: `prompt_file 读失败 (${relativePath}): ${formatErr(readErr)}` };
    }
    const filledPrompt = promptTemplate
      .replace(/\{\{evidence\}\}/g, evidence)
      .replace(/\{\{artifacts\}\}/g, artifacts.join(', '))
      .replace(/\{\{subtask_description\}\}/g, subtaskDesc);

    const result = await ctx.runVerifierWithCancel(contractId, {
      agentId: `verifier-${contractId}-${subtaskId}`,
      contractId,
      prompt: filledPrompt,
      clawDir: contractAbsDir,
      clawId: ctx.clawId,
      llm: ctx.llm!,
      fs: ctx.fs,
      audit: ctx.audit,
      maxSteps: DEFAULT_MAX_STEPS,
      idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
      onIdleTimeout: () => {
        emitContractVerificationTimeout(
          ctx.audit,
          { contractId, subtaskId, claw: ctx.clawId },
        );
      },
      toolRegistry: ctx.toolRegistry,
      toolTimeoutMs: ctx.toolTimeoutMs,
    });
    return result;
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = formatErr(err);
    return { passed: false, feedback: `LLM 验收失败: ${msg}` };
  }
}
