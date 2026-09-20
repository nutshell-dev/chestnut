/**
 * @module L6.CLIProtocol.ContractCommandCatalog
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: contract 命令族 catalog 单源。
 *
 * 单源原则（对齐 phase 1798 claw 族 / 1874 motion 族）：contract 命令的 summary / option
 * 形状只由本 catalog 派生；cli/index.ts 注册点经 `applyCommandOptions` 投影消费。
 * 历史：字面源自 cli/index.ts contract 族注册（逐字迁移、零行为变化）。
 */

import type { CommandShapeSpec } from './command-shape.js';

export const CONTRACT_COMMAND_CATALOG = [
  {
    id: 'create',
    summary: 'Create a contract (--file: import YAML, --dir: directory with contract.yaml + verification/)',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID', required: true },
      { flag: '--file <path>', desc: 'Path to contract YAML file' },
      { flag: '--dir <path>', desc: 'Directory containing contract.yaml and verification/ folder' },
    ],
  },
  {
    id: 'show',
    summary: 'Show contract state snapshot for a claw',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID', required: true },
      { flag: '--contract <id>', desc: 'Contract ID (default: active contract)' },
    ],
  },
  {
    id: 'cancel',
    summary: 'Cancel an active contract (legacy paused contracts are read-only)',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID', required: true },
      { flag: '--reason <text>', desc: 'Cancel reason (recorded as immutable lifecycle intent)', required: true },
      { flag: '--contract <id>', desc: 'Contract ID (default: active contract)' },
    ],
  },
  {
    id: 'events',
    summary: 'Show contract events since a timestamp',
    options: [{ flag: '--since <timestamp>', desc: 'Unix timestamp in milliseconds', required: true }],
  },
] as const satisfies readonly CommandShapeSpec[];

export type ContractCommandId = typeof CONTRACT_COMMAND_CATALOG[number]['id'];

export function getContractCommandSpec(id: string): CommandShapeSpec | undefined {
  return CONTRACT_COMMAND_CATALOG.find((spec) => spec.id === id);
}
