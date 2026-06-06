/**
 * LLM Provider audit event names.
 *
 * Module-owned event namespace per H1 design.
 * 字符串值与 foundation/audit/audit-events.snapshot.json 等价 / 0 漂移。
 */

import type { IdNamingEntry } from '../audit/types.js';

export const LLM_PROVIDER_AUDIT_EVENTS = {
  TOOL_RESULT_MISSING_ID: 'llm_provider_tool_result_missing_id',
  TOOL_RESULT_ORPHAN_ID: 'llm_provider_tool_result_orphan_id',
  ASSISTANT_EMPTY_CONTENT_SKIPPED: 'llm_provider_assistant_empty_content_skipped',
} as const;

/**
 * Phase 140: llm-provider 业主声明 ID-naming map.
 *
 * SoT: llm-provider own ToolUseId brand (LLM protocol tool_use block id).
 */
export const LLM_PROVIDER_ID_NAMING: Readonly<Record<string, IdNamingEntry>> = {
  toolUse: {
    auditCol: 'tool_use_id',
    dialogMeta: 'tool_use_id',
    tsField: 'toolUseId',  // ToolUseId brand (Step B)
    cliFlag: '--col tool_use_id',
  },
} as const;
