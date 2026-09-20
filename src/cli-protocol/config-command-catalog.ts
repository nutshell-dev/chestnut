/**
 * @module L6.CLIProtocol.ConfigCommandCatalog
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: config / provider 命令族
 * catalog 单源（族 3b）。
 * 历史：字面源自 cli/commands/config.ts 注册（逐字迁移、零行为变化）。
 */

import type { CommandShapeSpec } from './command-shape.js';

export const CONFIG_COMMAND_CATALOG = [
  { id: 'config', summary: 'Manage chestnut configuration' },
  { id: 'config/provider', summary: 'Manage LLM providers' },
  { id: 'config/provider/add', summary: 'Add a new provider interactively' },
  { id: 'config/provider/list', summary: 'List all providers' },
  { id: 'config/provider/remove', summary: 'Remove a fallback provider' },
  { id: 'config/provider/set-primary', summary: 'Set a provider as primary (current primary becomes fallback)' },
  { id: 'config/provider/move', summary: 'Move a fallback provider to a new position (1-based)' },
] as const satisfies readonly CommandShapeSpec[];

export type ConfigCommandId = typeof CONFIG_COMMAND_CATALOG[number]['id'];

export function getConfigCommandSpec(id: string): CommandShapeSpec | undefined {
  return CONFIG_COMMAND_CATALOG.find((spec) => spec.id === id);
}
