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
import { ToolTimeoutError } from '../../foundation/tools/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import type { ContractId } from './types.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { PathGuardError } from '../../foundation/fs/index.js';
// phase 1490: 不再传 maxSteps、VerifierConfig.maxSteps optional / undefined 透传到 SubAgent boundary fallback。
// phase 1376: contractAbsDir is clawDir, branded
import {
  emitContractVerificationScriptStarted,
  emitContractVerificationTimeout,
} from './audit-emit.js';
import {
  llmNotConfiguredFeedback,
  llmVerificationFailedFeedback,
  promptFileEscapedClawFeedback,
  promptFilePathRejectedFeedback,
  promptFileReadFailedFeedback,
  scriptFilePathRejectedFeedback,
  scriptVerificationFailedFeedback,
  scriptVerificationPassedFeedback,
  scriptVerificationTimeoutFeedback,
  verifierSubagentTimeoutFeedback,
} from '../../templates/messages/index.js';

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
    return { passed: false, feedback: scriptFilePathRejectedFeedback() };
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
    return { passed: true, feedback: scriptVerificationPassedFeedback() };
  } catch (err) {
    // Phase 965: abort is not a verification failure — don't convert to passed:false.
    if (ctx.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    if (!(err instanceof ProcessExecError)) {
      return { passed: false, feedback: scriptVerificationFailedFeedback(formatErr(err)) };
    }
    const detail = err.output || err.message;
    const firstLine = detail.split('\n').find(l => l.trim()) ?? detail.trim();
    return {
      passed: false,
      feedback: err.killed
        ? scriptVerificationTimeoutFeedback(firstLine)
        : scriptVerificationFailedFeedback(firstLine),
    };
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
    return { passed: false, feedback: llmNotConfiguredFeedback() };
  }
  const resolved = checkPathContainment(ctx.fs, contractAbsDir, promptFile);
  if (!resolved) {
    return { passed: false, feedback: promptFilePathRejectedFeedback() };
  }
  try {
    // Phase 965: resolved is realPath; compare against realpath'd clawDir to avoid symlink mismatch on macOS (/var vs /private).
    const realClawDir = ctx.fs.realpathSync(ctx.clawDir);
    const relativePath = path.relative(realClawDir, resolved);
    if (relativePath.startsWith('..')) {
      return { passed: false, feedback: promptFileEscapedClawFeedback() };
    }
    let promptTemplate: string;
    try {
      promptTemplate = await ctx.fs.read(relativePath);
    } catch (readErr) {
      return { passed: false, feedback: promptFileReadFailedFeedback(relativePath, formatErr(readErr)) };
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
      return { passed: false, feedback: verifierSubagentTimeoutFeedback() };
    }
    const msg = formatErr(err);
    return { passed: false, feedback: llmVerificationFailedFeedback(msg) };
  }
}
