/**
 * @module L6.CLIProtocol.MiscCommandCatalog
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: skill / watchdog / audit
 * 命令族 catalog 单源（族 3a）。
 *
 * 单源原则（对齐 phase 1798 claw / 1874 motion / contract 族）：summary / option 形状只由
 * 本 catalog 派生；cli/index.ts 注册点经 `applyCommandOptions` 投影消费。
 * 历史：字面源自 cli/index.ts 对应族注册（逐字迁移、零行为变化）。
 */

import type { CommandShapeSpec } from './command-shape.js';

export const MISC_COMMAND_CATALOG = [
  {
    id: 'skill/install',
    summary: 'Install a skill from local path, or install dispatch-skill to a claw (--claw)',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID (internal mode: install from dispatch-skills to claw)' },
      { flag: '--skill <name>', desc: 'Skill name (required with --claw)' },
    ],
  },
  { id: 'watchdog/start', summary: 'Start watchdog' },
  { id: 'watchdog/stop', summary: 'Stop watchdog' },
  {
    id: 'audit/query',
    summary: 'Query audit log records with filters and optional follow',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID', required: true },
      // 运行时 default = AUDIT_FILE_STEM 常量（owner: foundation/audit）→ 注册点字面（1798 边界）。
      { flag: '--file <name>', desc: 'Audit file name (multi-file aware)', runtimeLiteral: true },
      { flag: '--all-files', desc: 'Query across all audit files in this claw' },
      { flag: '--type <pattern>', desc: 'Glob pattern matched against event type (e.g. cron_*)' },
      { flag: '--since-ts <iso>', desc: 'Inclusive lower bound on ts (ISO 8601)' },
      { flag: '--until-ts <iso>', desc: 'Inclusive upper bound on ts (ISO 8601)' },
      { flag: '--from-seq <n>', desc: 'Inclusive lower bound on seq' },
      { flag: '--to-seq <n>', desc: 'Inclusive upper bound on seq' },
      { flag: '--trace <id>', desc: 'Exact trace_id match' },
      // fn parser（collectColFilter）+ {} default → 注册点字面。
      { flag: '--col <key=val>', desc: 'Col filter (AND semantics, repeatable)', runtimeLiteral: true },
      { flag: '--limit <n>', desc: 'Max records to yield' },
      { flag: '--json', desc: 'Output as JSON-line (default TSV passthrough)' },
      { flag: '--follow', desc: 'Tail mode: emit existing then watch for new appends' },
      { flag: '--tool-use-id <id>', desc: 'Filter by tool_use_id (exact match)' },
      { flag: '--step <n>', desc: 'Filter by step number (exact match)' },
      { flag: '--contract-id <id>', desc: 'Filter by contract_id (exact match)' },
      { flag: '--subtask-id <id>', desc: 'Filter by subtask_id (exact match)' },
      { flag: '--no-hint', desc: 'Suppress 0 result hint to stderr' },
    ],
  },
  {
    id: 'audit/lookup',
    summary: 'Look up original content by --tool-use-id or --block-id (4-level fallback: archive → current → unavailable)',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID', required: true },
      { flag: '--tool-use-id <id>', desc: 'Look up by tool_use_id' },
      { flag: '--block-id <id>', desc: 'Look up by block ID (8-char short form, from context-trim suffix)' },
      { flag: '--content-hash <sha8>', desc: 'Optional sha8 hash for integrity verification (--tool-use-id mode only)' },
      { flag: '--json', desc: 'Output as JSON' },
    ],
  },
  {
    id: 'audit/info',
    summary: 'Show audit file metadata and schema routing',
    options: [
      { flag: '-c, --claw <id>', desc: 'Target claw ID', required: true },
      { flag: '--json', desc: 'Output as JSON' },
    ],
  },
] as const satisfies readonly CommandShapeSpec[];

export type MiscCommandId = typeof MISC_COMMAND_CATALOG[number]['id'];

export function getMiscCommandSpec(id: string): CommandShapeSpec | undefined {
  return MISC_COMMAND_CATALOG.find((spec) => spec.id === id);
}
