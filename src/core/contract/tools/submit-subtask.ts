/**
 * submit_subtask tool - Mark subtask as complete and trigger verification
 * 
 * This tool is used by Claws to signal completion of a subtask,
 * which triggers the verification process defined in the contract.
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { ContractSystem } from '../manager.js';
import { makeContractId, makeSubtaskId, type SubtaskId } from '../types.js';

/**
 * Done tool implementation
 * 
 * Requires contractManager to be injected before use.
 */
export const SUBMIT_SUBTASK_TOOL_NAME = 'submit_subtask' as const;

export function createSubmitSubtaskTool(contractManager: ContractSystem): Tool {
  return {
    name: SUBMIT_SUBTASK_TOOL_NAME,
    profiles: ['full'],
    group: 'subagent-protocol',
    description: 'Mark a subtask as complete and submit it for verification. ' +
      'Verification runs asynchronously — the result (pass or reject) will be ' +
      'delivered to your inbox. Check inbox for feedback before proceeding.',
    schema: {
      type: 'object',
      properties: {
        subtask: {
          type: 'string',
          description: 'The subtask ID to mark as complete',
        },
        evidence: {
          type: 'string',
          description: 'Evidence or summary of what was accomplished',
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of output files or artifacts produced (optional)',
        },
      },
      required: ['subtask', 'evidence'],
    },
    readonly: false,
    idempotent: false,

    async execute(args: Record<string, unknown>, _ctx: ExecContext): Promise<ToolResult> {
      const active = await contractManager.loadActive();
      if (!active) {
        return {
          success: false,
          content: 'No active contract',
          error: 'No active contract',
        };
      }

      const subtaskId: SubtaskId = makeSubtaskId(String(args.subtask));
      const evidence = String(args.evidence);
      const artifacts = (args.artifacts as string[]) || [];

      const result = await contractManager.completeSubtask({
        contractId: makeContractId(active.id),
        subtaskId,
        evidence,
        artifacts,
      });

      // Async verification path (has verification config)
      if (result.async) {
        return {
          success: true,
          content: `Subtask ${subtaskId} submitted for verification.\nResult will arrive via inbox — check inbox before starting the next subtask.`,
          metadata: { contractId: active.id, subtaskId, async: true },
        };
      }

      // Sync verification path (no verification config)
      if (result.passed) {
        if (result.allCompleted) {
          return {
            success: true,
            content: `Subtask ${subtaskId} accepted. All subtasks complete!`,
            metadata: { contractId: active.id, subtaskId },
          };
        }
        // 从 active 契约中读取剩余列表（此时契约仍在 active/，未 archive）
        const updated = await contractManager.loadActive();
        const remaining = updated?.subtasks.filter(s => s.status !== 'completed') ?? [];
        const remainingList = remaining.map(s => `- ${s.id}: ${s.description}`).join('\n');
        return {
          success: true,
          content: `Subtask ${subtaskId} accepted. ${remaining.length} subtask(s) remaining:\n${remainingList}\n\nNote: contract completion is notified to Motion only when all subtasks are accepted.`,
          metadata: { contractId: active.id, subtaskId },
        };
      } else {
        return {
          success: false,
          content: `Subtask ${subtaskId} rejected:\n${result.feedback}`,
          error: result.feedback,
          metadata: { contractId: active.id, subtaskId },
        };
      }
    },
  };
}
