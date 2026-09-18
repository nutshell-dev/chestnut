import * as path from 'path';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { Tool, ExecContext } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import { readTool } from '../../foundation/file-tool/index.js';
import { lsTool } from '../../foundation/file-tool/index.js';
import { searchTool } from '../../foundation/file-tool/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { ClawIdResolveError, type ClawTopology } from './types.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from './audit-events.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';
import { makeExternalAbortError } from '../../foundation/llm-provider/index.js';

/**
 * phase 1864 Step G（CT-D10）：跨目标访问 access capability——装配期授予、明确授权主体。
 *
 * caller 的 permissionChecker 是 caller-claw scoped；target 操作必须用 target 面
 * checker（本 capability 按 target 构造），不再以 spread 隐式沿用 caller 的 checker。
 */
export interface CrossTargetAccess {
  /** 授权主体标签（装配期决定；如 motion 面 / 普通 agent 面跨目标 adapter）。 */
  readonly grantedBy: string;
  /** 为具体 target 构造 checker（fs = 该 target 的 fs）。 */
  createChecker(target: { readonly clawDir: string; readonly fs: FileSystem }): PermissionChecker;
}

/**
 * phase 1864 Step H（CT-D11）：broadcast 授权 capability——装配期授予、type 层表达。
 *
 * 非授权装配（无本 capability）的 registry 不持 broadcast 面；授权主体
 * （grantedTo）在构造期绑定，替代可伪造 boolean + 运行期目录名判定。
 * 运行期 ctx.clawId 复核保留为第二道（防 motion registry 被非 motion 上下文挪用，
 * 如 shadow restricted registry 复用同一 registry 的场景）。
 */
export interface BroadcastGrant {
  /** 授权主体（构造期绑定；仅其上下文可 broadcast）。 */
  readonly grantedTo: ClawId;
}

/** phase 520: motionClawId DI 删除（caller 不再传）、agent-tools 直 import 自家 const */
interface CrossClawToolDeps {
  topology: ClawTopology;
  /** phase 1864 Step H（CT-D11）：缺省 = 无 broadcast 能力（单目标面仍可用）。 */
  broadcast?: BroadcastGrant;
  /** phase 1864 Step G（CT-D10）：跨目标访问 capability（装配期注入）。 */
  crossTargetAccess: CrossTargetAccess;
}

function buildTargetCtx(
  baseCtx: ExecContext,
  targetClawDir: string,
  access: CrossTargetAccess,
): ExecContext {
  if (!baseCtx.fsFactory) {
    throw new Error('Cross-claw access requires fsFactory in ExecContext');
  }
  const targetFs = baseCtx.fsFactory(targetClawDir);
  return {
    ...baseCtx,
    clawDir: targetClawDir,
    workspaceDir: path.join(targetClawDir, CLAWSPACE_DIR),
    fs: targetFs,
    // phase 1864 Step G（CT-D10）：permission 面显式替换为 target 面 capability——
    // 不继承 caller 的 claw-scoped checker。
    permissionChecker: access.createChecker({ clawDir: targetClawDir, fs: targetFs }),
    readFileState: new Map(),
    // Phase 1229 Step B: cross-claw target ctx must not persist read-state to target claw disk.
    // The wrapped read only returns content; caller and target claw overwrite-gate states
    // must not be polluted by a transient cross-claw Map.
    persistReadFileState: false,
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
        const targetCtx = buildTargetCtx(ctx, location.clawDir, deps.crossTargetAccess);
        return readTool.execute(stripClaw(args), targetCtx);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal?.reason);
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
            : `Error accessing claw "${clawParam}": ${formatErr(err)}`,
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
        const targetCtx = buildTargetCtx(ctx, location.clawDir, deps.crossTargetAccess);
        return lsTool.execute(stripClaw(args), targetCtx);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal?.reason);
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
            : `Error accessing claw "${clawParam}": ${formatErr(err)}`,
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
        // DP11 enforce: Motion-only —— 授权经构造期 capability 表达；
        // 运行期 ctx.clawId 复核保留（registry 复用场景的第二道，防伪主体）。
        if (!deps.broadcast || ctx.clawId !== deps.broadcast.grantedTo) {
          ctx.auditWriter?.write(
            CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION,
            `callerClawId=${ctx.clawId}`,
            deps.broadcast ? 'reason=runtime_claw_not_motion' : 'reason=not_motion_chain',
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
            throw makeExternalAbortError(ctx.signal.reason);
          }
          try {
            const location = deps.topology.resolve(clawId);
            const targetCtx = buildTargetCtx(ctx, location.clawDir, deps.crossTargetAccess);
            const result = await searchTool.execute(stripClaw(args), targetCtx);
            results.push({ clawId, result });
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
              throw makeExternalAbortError(ctx.signal?.reason);
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
        const targetCtx = buildTargetCtx(ctx, location.clawDir, deps.crossTargetAccess);
        return searchTool.execute(stripClaw(args), targetCtx);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' || ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal?.reason);
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
            : `Error accessing claw "${clawParam}": ${formatErr(err)}`,
        };
      }
    },
  };
}
