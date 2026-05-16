/**
 * ReportResultTool — Structured output tool for LLM agents
 *
 * Registers as a regular tool. When the LLM calls it, the arguments
 * (validated JSON by the SDK) are captured in `capturedResult`.
 *
 * Usage:
 *   const tool = new ReportResultTool();
 *   registry.register(tool);
 *   await agent.run();
 *   if (tool.capturedResult) { ... }
 *
 * Compatible with any agent that needs guaranteed JSON output.
 * Currently used by contract LLM acceptance verifiers.
 */

import type { Tool, ToolResult, ExecContext } from '../../../foundation/tool-protocol/index.js';

/** Tool name const（M#3 资源唯一归属 / caller 经 import 显式 dep / phase 824 step B1）*/
export const REPORT_RESULT_TOOL_NAME = 'report_result' as const;

export interface ReportResultPayload {
  passed: boolean;
  reason: string;
  issues?: string[];
}

export class ReportResultTool implements Tool {
  readonly name = REPORT_RESULT_TOOL_NAME;
  readonly description =
    'Submit your verification verdict. Call this tool exactly once when you have finished ' +
    'inspecting the evidence and artifacts. Do NOT return JSON in text — call this tool instead.';
  readonly schema = {
    type: 'object' as const,
    properties: {
      passed: {
        type: 'boolean' as const,
        description: 'true if the subtask output meets all acceptance criteria, false otherwise',
      },
      reason: {
        type: 'string' as const,
        description: 'One-sentence explanation of the verdict',
      },
      issues: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'List of specific issues found (only required when passed=false)',
      },
    },
    required: ['passed', 'reason'],
  };
  readonly readonly = true;
  readonly idempotent = false;

  capturedResult: ReportResultPayload | null = null;

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    this.capturedResult = {
      passed: Boolean(args.passed),
      reason: String(args.reason ?? ''),
      issues: Array.isArray(args.issues) ? (args.issues as string[]) : undefined,
    };
    // phase 777: hard-stop verifier loop (mirror done.ts)
    ctx.requestStop();
    return { success: true, content: 'Verdict recorded. Agent will exit.' };
  }
}
