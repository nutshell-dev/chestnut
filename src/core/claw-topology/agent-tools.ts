import * as path from 'path';
import type { Tool, ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import { readTool, lsTool, searchTool } from '../../foundation/file-tool/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { ClawIdResolveError, type ClawTopology } from './types.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from './audit-events.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';
import { makeExternalAbortError, type AbortReason } from '../../foundation/llm-provider/index.js';

/** phase 520: motionClawId DI 删除（caller 不再传）、agent-tools 直 import 自家 const */
interface CrossClawToolDeps {
  topology: ClawTopology;
  allowed: boolean;
}

function buildTargetCtx(baseCtx: ExecContext, targetClawDir: string): ExecContext {
  if (!baseCtx.fsFactory) {
    throw new Error('Cross-claw access requires fsFactory in ExecContext');
  }
  return {
    ...baseCtx,
    clawDir: targetClawDir,
    workspaceDir: path.join(targetClawDir, CLAWSPACE_DIR),
    fs: baseCtx.fsFactory(targetClawDir),
    readFileState: new Map(),
  };
}

function stripClaw(args: Record<string, unknown>): Record<string, unknown> {
  const { claw: _claw, ...rest } = args;
  return rest;
}

function validateClawParam(clawParam: string): ToolResult | null {
  if (
    clawParam.includes('/') ||
    clawParam.includes('..') ||
    clawParam === '' ||
    clawParam === '.' ||
    clawParam.startsWith('.')
  ) {
    return {
      success: false,
      content: `Error: Invalid claw ID: "${clawParam}"`,
    };
  }
  return null;
}

export function createCrossClawReadTool(deps: CrossClawToolDeps): Tool {
  return {
    ...readTool,
    schema: {
      ...readTool.schema,
      properties: {
        ...readTool.schema.properties,
        claw: {
          type: 'string',
          description: 'Cross-claw target claw ID. Omit for same-claw read. "*" not supported by read.',
        },
      },
    },
    async execute(args, ctx) {
      const clawParam = args.claw as string | undefined;
      if (!clawParam) {
        return readTool.execute(args, ctx);
      }
      if (clawParam === '*') {
        return {
          success: false,
          content: 'Error: claw: "*" broadcast is not supported by read (only search supports it).',
        };
      }
      const validation = validateClawParam(clawParam);
      if (validation) return validation;
      try {
        const location = deps.topology.resolve(makeClawId(clawParam));
        if (location.kind !== 'local') {
          return {
            success: false,
            content: `Error: remote claw "${clawParam}" not supported in single-host mode.`,
          };
        }
        const targetCtx = buildTargetCtx(ctx, location.clawDir);
        return readTool.execute(stripClaw(args), targetCtx);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal?.reason as AbortReason | undefined);
        }
        ctx.auditWriter?.write(
          CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED,
          `clawId=${clawParam}`,
          `reason=${String(err)}`,
        );
        // Only ClawIdResolveError means the claw genuinely doesn't exist.
        // All other errors (EACCES, fsFactory failure, tool execution error)
        // must preserve their actual cause so the agent can reason about the failure.
        const isNotFound = err instanceof ClawIdResolveError;
        return {
          success: false,
          content: isNotFound
            ? `Error: claw "${clawParam}" not found.`
            : `Error accessing claw "${clawParam}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

export function createCrossClawLsTool(deps: CrossClawToolDeps): Tool {
  return {
    ...lsTool,
    schema: {
      ...lsTool.schema,
      properties: {
        ...lsTool.schema.properties,
        claw: {
          type: 'string',
          description: 'Cross-claw target claw ID. Omit for same-claw ls. "*" not supported by ls.',
        },
      },
    },
    async execute(args, ctx) {
      const clawParam = args.claw as string | undefined;
      if (!clawParam) {
        return lsTool.execute(args, ctx);
      }
      if (clawParam === '*') {
        return {
          success: false,
          content: 'Error: claw: "*" broadcast is not supported by ls (only search supports it).',
        };
      }
      const validation = validateClawParam(clawParam);
      if (validation) return validation;
      try {
        const location = deps.topology.resolve(makeClawId(clawParam));
        if (location.kind !== 'local') {
          return {
            success: false,
            content: `Error: remote claw "${clawParam}" not supported in single-host mode.`,
          };
        }
        const targetCtx = buildTargetCtx(ctx, location.clawDir);
        return lsTool.execute(stripClaw(args), targetCtx);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal?.reason as AbortReason | undefined);
        }
        ctx.auditWriter?.write(
          CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED,
          `clawId=${clawParam}`,
          `reason=${String(err)}`,
        );
        const isNotFound = err instanceof ClawIdResolveError;
        return {
          success: false,
          content: isNotFound
            ? `Error: claw "${clawParam}" not found.`
            : `Error accessing claw "${clawParam}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function aggregateBroadcastResults(
  results: { clawId: string; result: ToolResult }[],
  pattern: string,
): ToolResult {
  const successes = results.filter(r => r.result.success);
  const failures = results.filter(r => !r.result.success);
  if (failures.length === results.length && results.length > 0) {
    const failedClaws = failures.map(f => f.clawId).join(', ');
    return { success: false, content: `Search failed: all ${results.length} claws failed (${failedClaws}).` };
  }
  const blocks: string[] = [];
  for (const s of successes) {
    if (s.result.content && s.result.content !== `No matches for "${pattern}".`) {
      blocks.push(`[${s.clawId}]\n${s.result.content}`);
    }
  }
  let content = blocks.join('\n\n');
  if (failures.length > 0) {
    const failedClaws = failures.map(f => f.clawId).join(', ');
    content += `${content ? '\n\n' : ''}(⚠ ${failures.length}/${results.length} claws failed: ${failedClaws})`;
  }
  if (!content) {
    return { success: true, content: `No matches for "${pattern}".` };
  }
  return { success: true, content };
}

export function createCrossClawSearchTool(deps: CrossClawToolDeps): Tool {
  return {
    ...searchTool,
    schema: {
      ...searchTool.schema,
      properties: {
        ...searchTool.schema.properties,
        claw: {
          type: 'string',
          description: 'Target claw ID (specific target: any agent; "*" broadcast: Motion only). Both prefix matches with [clawId]. Example: { text: "error", path: "logs/", claw: "*" }',
        },
      },
    },
    async execute(args, ctx) {
      const clawParam = args.claw as string | undefined;
      if (!clawParam) {
        return searchTool.execute(args, ctx);
      }
      if (clawParam === '*') {
        // DP11 enforce: Motion-only
        if (!deps.allowed) {
          ctx.auditWriter?.write(
            CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION,
            `callerClawId=${ctx.clawId}`,
            'reason=not_motion_chain',
          );
          return {
            success: false,
            content: 'Error: claw: "*" broadcast is Motion-only. Use claw: "<id>" for specific claw access.',
          };
        }
        // fan-out 所有 claws、聚合结果
        const clawIds = deps.topology.enumerate().filter(id => id !== MOTION_CLAW_ID);
        const results: { clawId: string; result: ToolResult }[] = [];
        const rawText = args.text as string;
        for (const clawId of clawIds) {
          if (ctx.signal?.aborted) {
            throw makeExternalAbortError(ctx.signal.reason as AbortReason | undefined);
          }
          try {
            const location = deps.topology.resolve(clawId);
            if (location.kind !== 'local') continue;
            const targetCtx = buildTargetCtx(ctx, location.clawDir);
            const result = await searchTool.execute(stripClaw(args), targetCtx);
            results.push({ clawId, result });
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
              throw makeExternalAbortError(ctx.signal?.reason as AbortReason | undefined);
            }
            ctx.auditWriter?.write(
              CLAW_TOPOLOGY_AUDIT_EVENTS.BROADCAST_CLAW_SKIPPED,
              `claw=${clawId}`,
              `reason=${String(err)}`,
            );
            results.push({
              clawId,
              result: { success: false, content: `Error: ${String(err)}` },
            });
          }
        }
        return aggregateBroadcastResults(results, rawText);
      }
      // single target cross-claw
      const validation = validateClawParam(clawParam);
      if (validation) return validation;
      try {
        const location = deps.topology.resolve(makeClawId(clawParam));
        if (location.kind !== 'local') {
          return {
            success: false,
            content: `Error: remote claw "${clawParam}" not supported in single-host mode.`,
          };
        }
        const targetCtx = buildTargetCtx(ctx, location.clawDir);
        return searchTool.execute(stripClaw(args), targetCtx);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal?.reason as AbortReason | undefined);
        }
        ctx.auditWriter?.write(
          CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED,
          `clawId=${clawParam}`,
          `reason=${String(err)}`,
        );
        const isNotFound = err instanceof ClawIdResolveError;
        return {
          success: false,
          content: isNotFound
            ? `Error: claw "${clawParam}" not found.`
            : `Error accessing claw "${clawParam}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
