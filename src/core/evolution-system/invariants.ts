// src/core/evolution-system/invariants.ts

/**
 * Retrospective work item row schema invariant.
 *
 * Validates that a parsed disk row conforms to RetrospectiveWorkItemV1
 * before downstream code treats it as authoritative.
 *
 * Does not throw — emits an audit event so invariant violations are
 * observable without breaking the caller's business path.
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';

const RETROSPECTIVE_ROW_CURRENT_SCHEMA_VERSION = 1;

export function assertRetrospectiveRowShape(
  row: unknown,
  audit: AuditLog,
  source: string,
): void {
  if (typeof row !== 'object' || row === null) {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `source=${source}`,
      `kind=row_not_object`,
      `actual=${typeof row}`,
    );
    return;
  }

  const r = row as Record<string, unknown>;

  if (r.schema_version !== RETROSPECTIVE_ROW_CURRENT_SCHEMA_VERSION) {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `source=${source}`,
      `kind=schema_version_mismatch`,
      `actual=${String(r.schema_version)}`,
      `expected=${RETROSPECTIVE_ROW_CURRENT_SCHEMA_VERSION}`,
    );
    return;
  }

  const missing: string[] = [];
  if (typeof r.contract_id !== 'string') missing.push('contract_id');
  if (typeof r.task_id !== 'string') missing.push('task_id');
  if (typeof r.target_claw !== 'string') missing.push('target_claw');
  if (typeof r.created_at !== 'string') missing.push('created_at');

  if (missing.length > 0) {
    audit.write(
      RETRO_AUDIT_EVENTS.EVOLUTION_STATE_INVARIANT_VIOLATED,
      `source=${source}`,
      `kind=missing_required_fields`,
      `fields=${missing.join(',')}`,
    );
  }
}
