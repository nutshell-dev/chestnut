/**
 * @module L6.CLIProtocol.MotionCommandCatalog
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: motion 命令族 catalog 单源。
 *
 * 单源原则（对齐 phase 1798 claw 族）：motion 命令的 summary / option 形状只由本
 * catalog 派生；cli/index.ts 注册点经 `applyCommandOptions` 投影消费。
 * 历史：字面源自 cli/index.ts motion 族注册（逐字迁移、零行为变化）。
 */

import type { CommandShapeSpec } from './command-shape.js';

export const MOTION_COMMAND_CATALOG = [
  { id: 'init', summary: 'Initialize Motion configuration' },
  { id: 'chat', summary: 'Chat with Motion' },
  { id: 'stop', summary: 'Stop Motion daemon' },
  {
    id: 'outbox',
    summary: "Drain Motion's outbox (send tool messages)",
    // 运行时 default 常量 owner = cli/commands/motion.ts DEFAULT_OUTBOX_DRAIN_LIMIT（CLIProtocol 不可
    // 反引 CLIProcess，故此处为展示字面）；一致性由 parity 测试断言（catalog ↔ owner 常量）。
    options: [{ flag: '--limit <n>', desc: 'Maximum messages to drain', defaultValue: '1', runtimeLiteral: true }],
  },
  {
    id: 'steps',
    summary: 'Show motion turn steps',
    options: [{ flag: '--no-hint', desc: 'Suppress step <n> usage hint' }],
  },
  { id: 'step', summary: 'Show full detail of a single motion turn' },
  { id: 'daemon', summary: 'Start Motion daemon (auto-backgrounds)' },
] as const satisfies readonly CommandShapeSpec[];

export type MotionCommandId = typeof MOTION_COMMAND_CATALOG[number]['id'];

export function getMotionCommandSpec(id: string): CommandShapeSpec | undefined {
  return MOTION_COMMAND_CATALOG.find((spec) => spec.id === id);
}
