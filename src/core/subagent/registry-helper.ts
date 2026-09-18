/**
 * Registry construction helpers.
 *
 * createPerTaskRegistry（phase 780 / 944）:
 * - skip the main shared DONE tool、注册 fresh done 实例
 * - 仍必要：per-task registry 需在非 'subagent' profile（如 shadow 的 'full'）下也含 done
 *   （done.profiles 仅 ['subagent']、不随 getForProfile 带出）
 *
 * bindRunCapture（phase 1858 Step F / SA-D5）:
 * - run-scoped 视图：DONE tool 条目替换为本 run 独占的 capture-bound 实例
 * - 与 createPerTaskRegistry 的关系：per-task fresh 实例只隔离「任务间」；本视图隔离「run 间」
 *   并对共享 registry（如 assembly base）直接生效——读侧（run.ts）不再触碰任何实例可变字段
 */

import { createToolRegistry, type Tool, type ToolRegistry } from '../../foundation/tools/index.js';
import type { ToolProfile } from '../../foundation/tool-protocol/index.js';
import { createDoneTool, DONE_TOOL_NAME, type ResultCaptureChannel } from './tools/done.js';

export function createPerTaskRegistry(
  srcRegistry: ToolRegistry,
  profile: string,
): ToolRegistry {
  const r = createToolRegistry();
  // `profile as any`: profile is runtime-typed string (caller boundary) — type guard at registry layer (phase 1382 audit-trail B-3 ratify)
  for (const tool of srcRegistry.getForProfile(profile as any)) {
    if (tool.name === DONE_TOOL_NAME) continue;
    r.register(tool);
  }
  r.register(createDoneTool());
  return r;
}

/**
 * phase 1858 Step F (SA-D5): run-scoped registry 视图。
 *
 * DONE tool 条目替换为本 run 独占的 capture-bound 实例（写入注入 channel）；
 * 其余条目透传。caller registry 不被修改，故多个 run 可安全共享同一 registry：
 * 各自结果经各自通道返回、零交叉（消除「读共享实例可变字段」的竞争/陈旧来源）。
 */
export function bindRunCapture(
  base: ToolRegistry,
  capture: ResultCaptureChannel<{ result: string }>,
): ToolRegistry {
  const bound = createDoneTool(capture);
  const substitute = (tool: Tool): Tool => (tool.name === DONE_TOOL_NAME ? bound : tool);
  return {
    register: (tool: Tool): void => base.register(tool),
    unregister: (name: string): void => base.unregister(name),
    get: (name: string): Tool | undefined =>
      name === DONE_TOOL_NAME && base.has(DONE_TOOL_NAME) ? bound : base.get(name),
    has: (name: string): boolean => base.has(name),
    getAll: (): Tool[] => base.getAll().map(substitute),
    getForProfile: (profile: ToolProfile): Tool[] => base.getForProfile(profile).map(substitute),
    formatForLLM: (tools: Tool[]) => base.formatForLLM(tools),
  };
}
