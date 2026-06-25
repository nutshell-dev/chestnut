/**
 * Phase 140: assembly-layer ID-naming aggregator.
 *
 * Per phase 136 §5.C ratified design, the id-naming map is owned by each
 * module (the "owner" of the corresponding ID dimension) and aggregated
 * here at the assembly layer for cross-module lookup.
 *
 * Invariants:
 * - Owners declare ID_NAMING in their own audit-events.ts (M#1 + M#5).
 * - Assembly only aggregates; it does not own any ID semantics.
 * - Audit column names (auditCol) are unique across the aggregated map.
 */

import type { IdNamingEntry } from '../foundation/audit/index.js';
import { RUNTIME_ID_NAMING } from '../core/runtime/runtime-audit-events.js';
import { CONTRACT_ID_NAMING } from '../core/contract/audit-events.js';
import { DIALOG_ID_NAMING } from '../foundation/dialog-store/audit-events.js';
export type { IdNamingEntry } from '../foundation/audit/index.js';

const LLM_PROVIDER_ID_NAMING: Readonly<Record<string, IdNamingEntry>> = {
  toolUse: {
    auditCol: 'tool_use_id',
    dialogMeta: 'tool_use_id',
    tsField: 'toolUseId',
    cliFlag: '--col tool_use_id',
  },
} as const;

export const AggregatedIdNamingMap: Readonly<Record<string, IdNamingEntry>> = {
  ...RUNTIME_ID_NAMING,
  ...CONTRACT_ID_NAMING,
  ...DIALOG_ID_NAMING,
  ...LLM_PROVIDER_ID_NAMING,
} as const;

