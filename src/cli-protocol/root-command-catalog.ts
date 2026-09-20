/**
 * @module L6.CLIProtocol.RootCommandCatalog
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: 顶层单命令 catalog 单源。
 * 历史：字面源自 cli/index.ts 顶层注册（逐字迁移、零行为变化）。
 */

import type { CommandShapeSpec } from './command-shape.js';

export const ROOT_COMMAND_CATALOG = [
  { id: 'stop', summary: 'Stop all chestnut processes (watchdog → motion → claws)' },
  { id: 'status', summary: 'Show status of all chestnut processes' },
  { id: 'start', summary: 'Start the system (initializes if needed) and open Motion chat' },
  { id: 'init', summary: 'Initialize chestnut workspace' },
] as const satisfies readonly CommandShapeSpec[];

export type RootCommandId = typeof ROOT_COMMAND_CATALOG[number]['id'];

export function getRootCommandSpec(id: string): CommandShapeSpec | undefined {
  return ROOT_COMMAND_CATALOG.find((spec) => spec.id === id);
}
