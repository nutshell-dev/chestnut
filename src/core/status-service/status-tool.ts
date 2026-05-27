/**
 * status tool - Get Claw status information
 * 
 * Enhanced with (MVP aligned):
 * - Active contract progress
 * - Task queue status
 * - MEMORY.md size, clawspace file count
 */

import type { Tool, ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ContractSystem } from '../contract/index.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR } from '../async-task-system/index.js';
import { STATUS_AUDIT_EVENTS } from './audit-events.js';

async function getContractStatus(ctx: ExecContext, contractSystem: ContractSystem): Promise<string> {
  try {
    const contract = await contractSystem.loadActive();
    if (!contract) return 'Contract: No active contract';

    // phase 458: 内联 view 计算（移自删除的 status-port-impl.ts createContractStatusPort）
    const doneCount = contract.subtasks.filter(s => s.status === 'completed').length;
    const totalCount = contract.subtasks.length;

    const lines = [`Contract: "${contract.title}" (${doneCount}/${totalCount} subtasks done)`];
    for (const s of contract.subtasks) {
      const icon = s.status === 'completed' ? '✓' : s.status === 'failed' ? '✗' : '○';
      lines.push(`  ${icon} ${s.id}: ${s.description}`);
    }
    return lines.join('\n');
  } catch (err) {
    ctx.auditWriter?.write(STATUS_AUDIT_EVENTS.CONTRACT_ERROR, `error=${err instanceof Error ? err.message : String(err)}`);
    return 'Contract: Error loading';
  }
}

async function getTaskStatus(ctx: ExecContext): Promise<string> {
  try {
    // Check if task system is functional by accessing its state
    // Design doc: was returning fake 'See task system logs', now shows actual status
    const pendingDir = TASKS_QUEUES_PENDING_DIR;
    const runningDir = TASKS_QUEUES_RUNNING_DIR;
    
    let pendingCount = 0;
    let runningCount = 0;
    
    try {
      const pending = await ctx.fs.list(pendingDir, { includeDirs: false });
      pendingCount = pending.length;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
        ctx.auditWriter?.write(STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR, `error=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    try {
      const running = await ctx.fs.list(runningDir, { includeDirs: false });
      runningCount = running.length;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
        ctx.auditWriter?.write(STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR, `error=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    if (runningCount > 0) {
      return `Tasks: ${runningCount} running, ${pendingCount} pending`;
    } else if (pendingCount > 0) {
      return `Tasks: ${pendingCount} pending`;
    } else {
      return 'Tasks: idle';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tasks: unavailable (${msg})`;
  }
}

async function getStorageStatus(ctx: ExecContext): Promise<string[]> {
  const lines: string[] = [];
  
  try {
    // MEMORY.md size
    if (await ctx.fs.exists('MEMORY.md')) {
      const content = await ctx.fs.read('MEMORY.md');
      lines.push(`MEMORY.md: ${(content.length / 1024).toFixed(1)}KB`);
    } else {
      lines.push('MEMORY.md: Not found');
    }
  } catch (err: unknown) {
    lines.push(`MEMORY.md: Error (${err instanceof Error ? err.message : 'unknown'})`);
  }
  
  try {
    // clawspace file count (ENOENT/FS_NOT_FOUND = 目录不存在，正常返回空)
    const entries = await ctx.fs.list(CLAWSPACE_DIR, { recursive: true, includeDirs: false }).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return [];
      throw err;
    });
    lines.push(`Clawspace: ${entries.length} files`);
  } catch (err: unknown) {
    lines.push(`Clawspace: Error (${err instanceof Error ? err.message : 'unknown'})`);
  }
  
  return lines;
}

import { CLAWSPACE_DIR } from '../../foundation/paths.js';
export const STATUS_TOOL_NAME = 'status' as const;

export function createStatusTool(contractSystem: ContractSystem): Tool {
  return {
    name: STATUS_TOOL_NAME,
    profiles: ['full', 'readonly'],
    group: 'status',
    description: 'Get comprehensive status: Claw ID, profile, step count, active contract with full subtask list (id/description/status), tasks, storage (MEMORY.md, clawspace). Call at turn start to re-orient after restart.',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    readonly: true,
    idempotent: true,
    supportsAsync: false,

    async execute(_args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const lines = [
        `Claw ID: ${ctx.clawId}`,
        `Profile: ${ctx.profile}`,
        `Step: ${ctx.stepNumber}/${ctx.maxSteps}`,
        `Elapsed: ${ctx.getElapsedMs()}ms`,
      ];
      
      // Add contract status (MVP aligned)
      lines.push(await getContractStatus(ctx, contractSystem));
      
      // Add task status (MVP aligned)
      lines.push(await getTaskStatus(ctx));
      
      // Add storage status (MVP aligned)
      lines.push(...await getStorageStatus(ctx));

      return {
        success: true,
        content: lines.join('\n'),
      };
    },
  };
}
