/**
 * @module L4.ContractSystem.Verification.Execution
 * Execution engine — script backend + LLM backend
 */

import * as path from 'path';
import type { VerificationContext } from './verification-types.js';
import type { VerificationResult, SubtaskId } from './types.js';
import { exec as defaultExec } from '../../foundation/process-exec/index.js';
import { ProcessExecError } from '../../foundation/process-exec/index.js';
import { CONTRACT_SCRIPT_TIMEOUT_MS } from './constants.js';
import { ToolTimeoutError } from '../../foundation/tools/errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import type { ContractId } from './types.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { PathGuardError } from '../../foundation/fs/types.js';
// phase 1490: 不再传 maxSteps、VerifierConfig.maxSteps optional / undefined 透传到 SubAgent boundary fallback。
// phase 1376: contractAbsDir is clawDir, branded
import {
  emitContractVerificationScriptStarted,
  emitContractVerificationTimeout,
} from './audit-emit.js';

export function checkPathContainment(fs: FileSystem, container: string, relativePath: string): string | null {
  const resolved = path.resolve(container, relativePath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (err) {
    if (err instanceof PathGuardError) {
      return null; // containment failed — caller decides
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null; // file doesn't exist yet (path is within container, just not created)
    }
    throw err; // EACCES, EIO — propagate
  }
  const realContainer = fs.realpathSync(container);
  if (!realPath.startsWith(realContainer + path.sep)) {
    return null; // outside container
  }
  return realPath;
}

export async function runScriptVerification(
  ctx: VerificationContext,
  scriptFile: string,
  contractAbsDir: string,
): Promise<VerificationResult> {
  const resolved = checkPathContainment(ctx.fs, contractAbsDir, scriptFile);
  if (!resolved) {
    return { passed: false, feedback: '路径安全拒绝: script_file 必须在契约目录内（或为不可解析的 symlink）' };
  }
  emitContractVerificationScriptStarted(
    ctx.audit,
    { script: scriptFile, cwd: ctx.clawDir },
  );
  try {
    await (ctx.exec ?? defaultExec)('sh', [resolved], {
      cwd: ctx.clawDir,
      timeout: CONTRACT_SCRIPT_TIMEOUT_MS,
      signal: ctx.signal, // Phase 963: propagate cancellation to script execution
    });
    return { passed: true, feedback: 'Script verification passed' };
  } catch (err) {
    // Phase 965: abort is not a verification failure — don't convert to passed:false.
    if (ctx.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
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
  const resolved = checkPathContainment(ctx.fs, contractAbsDir, promptFile);
  if (!resolved) {
    return { passed: false, feedback: '路径安全拒绝: prompt_file 必须在契约目录内' };
  }
  try {
    // Phase 965: resolved is realPath; compare against realpath'd clawDir to avoid symlink mismatch on macOS (/var vs /private).
    const realClawDir = ctx.fs.realpathSync(ctx.clawDir);
    const relativePath = path.relative(realClawDir, resolved);
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
      // phase 1490: maxSteps 不传、SubAgent boundary fallback to agent-executor DEFAULT_MAX_STEPS
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
    // Phase 963: abort is not a verification failure — don't convert to passed:false.
    if (ctx.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    if (err instanceof ToolTimeoutError) {
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = formatErr(err);
    return { passed: false, feedback: `LLM 验收失败: ${msg}` };
  }
}
