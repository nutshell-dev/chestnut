/**
 * @module L6.Assembly.WireClawTopology
 *
 * 装配协议：装 ClawTopology instance + 注册 3 个 cross-claw wrap tool 到 ToolRegistry。
 *
 * 必在 createFileTools register 之后调用（保 wrap 经 Map.set 同名替换覆盖 base）。
 *
 * 装配 ToolRegistry 处必经此 wire（per design interfaces/l4.md ClawTopology 节使用语义契约）、
 * 保 agent 视角 read/ls/search 含 `claw?` 字段、cross-claw 行为一致。
 */

import {
  createClawTopology,
  type ClawTopology,
} from '../core/claw-topology/index.js';
import {
  createCrossClawReadTool,
  createCrossClawLsTool,
  createCrossClawSearchTool,
} from '../core/claw-topology/agent-tools.js';
import type { ToolRegistry } from '../foundation/tools/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';

/** phase 520: motionClawId DI 删（topology 自家持 MOTION_CLAW_ID const、不需 assembly 注入） */
export interface WireClawTopologyDeps {
  fs: FileSystem;
  chestnutRoot: string;
  audit?: AuditLog;
  toolRegistry: ToolRegistry;
  motionDir?: string;
  isMotion: boolean;
}

export function wireClawTopology(deps: WireClawTopologyDeps): ClawTopology {
  const topology = createClawTopology({
    fs: deps.fs,
    chestnutRoot: deps.chestnutRoot,
    audit: deps.audit,
    motionDir: deps.motionDir ?? 'motion',
  });
  const wrapDeps = { topology, allowed: deps.isMotion };
  deps.toolRegistry.register(createCrossClawReadTool(wrapDeps));
  deps.toolRegistry.register(createCrossClawLsTool(wrapDeps));
  deps.toolRegistry.register(createCrossClawSearchTool(wrapDeps));
  return topology;
}
