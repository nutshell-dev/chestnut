/**
 * @module L6.CLIProtocol.SubagentCommandCatalog
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: subagent 命令族 catalog 单源（族 3b）。
 * 历史：字面源自 cli/commands/subagent.ts 注册（逐字迁移、零行为变化）。
 */

import type { CommandShapeSpec } from './command-shape.js';

export const SUBAGENT_COMMAND_CATALOG = [
  { id: 'subagent', summary: 'Subagent log observability commands' },
  {
    id: 'subagent/list',
    summary: 'List subagent tasks',
    options: [
      { flag: '-c, --claw <claw>', desc: 'Claw to query', required: true },
      // 动态 desc（枚举 SUBAGENT_STATUS_VALUES/SUBAGENT_KIND_VALUES、owner = cli/commands/subagent-helpers.ts）→ 注册点字面。
      { flag: '--status <status>', desc: 'Filter by status', runtimeLiteral: true },
      { flag: '--kind <kind>', desc: 'Filter by kind', runtimeLiteral: true },
      { flag: '--contract <id>', desc: 'Filter by contractId' },
      { flag: '--limit <n>', desc: 'Max rows (default: 20)' },
      { flag: '--from <ts>', desc: 'Filter started_at >= ts' },
      { flag: '--to <ts>', desc: 'Filter started_at <= ts' },
      { flag: '--json', desc: 'Output as JSON (machine-readable)' },
    ],
  },
  {
    id: 'subagent/steps',
    summary: 'Show subagent turn steps',
    options: [
      { flag: '-c, --claw <claw>', desc: 'Claw to query', required: true },
      { flag: '--json', desc: 'Output as JSON (machine-readable)' },
      { flag: '--no-hint', desc: 'Suppress step <n> usage hint' },
    ],
  },
  {
    id: 'subagent/step',
    summary: 'Show full detail of a single turn (n = "N" for whole turn, "N.x" for slot x)',
    options: [
      { flag: '-c, --claw <claw>', desc: 'Claw to query', required: true },
      { flag: '--json', desc: 'Output as JSON (machine-readable)' },
    ],
  },
] as const satisfies readonly CommandShapeSpec[];

export type SubagentCommandId = typeof SUBAGENT_COMMAND_CATALOG[number]['id'];

export function getSubagentCommandSpec(id: string): CommandShapeSpec | undefined {
  return SUBAGENT_COMMAND_CATALOG.find((spec) => spec.id === id);
}
