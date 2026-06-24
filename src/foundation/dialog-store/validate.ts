/**
 * @module L2b.DialogStore.Validate
 * 校验 / 迁移 / Marker 错误。
 *
 * 抽出自 store.ts、dialogstore-auditor §M-01 follow-up（SRP 拆分）。
 */

import type { Message } from '../llm-provider/types.js';
import type { AuditLog } from '../audit/index.js';
import type { SessionData } from './types.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import type { ToolUseId } from '../tool-protocol/index.js';

const SESSION_CURRENT_VERSION = 2;

export class MarkerNotFoundError extends Error {
  constructor(
    readonly clawId: string,
    readonly toolUseId: ToolUseId,
  ) {
    super(`marker not found: clawId=${clawId} toolUseId=${toolUseId}`);
    this.name = 'MarkerNotFoundError';
  }
}

/** v1 → v2 schema migration. */
export function detectAndMigrateVersion(
  parsed: Partial<SessionData>,
  filename: string,
  audit?: AuditLog,
): SessionData | null {
  // v1 → v2 intentional migration (phase 713 logic 保留)
  if (!parsed.toolsForLLM) {
    (parsed as SessionData).toolsForLLM = [];
    (parsed as SessionData).version = SESSION_CURRENT_VERSION;
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_MIGRATE, `file=${filename}`, `from=1`, `to=${SESSION_CURRENT_VERSION}`);
    return parsed as SessionData;
  }
  // NEW unknown version reject（phase 1019 r124 E fork）
  if (typeof parsed.version === 'number' && parsed.version > SESSION_CURRENT_VERSION) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN, `file=${filename}`,
      `actual=${parsed.version}`, `current=${SESSION_CURRENT_VERSION}`);
    return null;  // caller treats as corrupt
  }
  return parsed as SessionData;
}

/** Standalone validateSessionData（外部 caller 用：cli/trace + cli/_message-renderer）*/
export function validateSessionData(
  data: SessionData,
  audit?: AuditLog,
  clawIdFallback?: string,
): SessionData {
  let version: number = data.version ?? SESSION_CURRENT_VERSION;
  if (typeof version !== 'number' || version > SESSION_CURRENT_VERSION || version < 1) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.INVARIANT_FAILED, `field=version`, `got=${String(data.version)}`, `fallback=${SESSION_CURRENT_VERSION}`);
    version = SESSION_CURRENT_VERSION;
  }
  if (!Number.isInteger(version)) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.INVARIANT_FAILED, `field=version`, `got=${String(data.version)}`, `reason=non_integer`);
    version = SESSION_CURRENT_VERSION;
  }
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((m): m is Message => {
        const valid = m != null && typeof m === 'object' && 'role' in m && 'content' in m;
        if (!valid) {
          audit?.write?.(DIALOG_AUDIT_EVENTS.INVARIANT_FAILED, `field=messages.entry`, `got=${typeof m}`, `filter=skipped`);
        }
        return valid;
      })
    : [];
  return {
    version: version as SessionData['version'],
    clawId: data.clawId ?? clawIdFallback,
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    systemPrompt: data.systemPrompt ?? '',
    messages,
    toolsForLLM: Array.isArray(data.toolsForLLM) ? data.toolsForLLM : [],
  };
}

/** Standalone migrateAndValidateSession（外部 caller 用：cli/trace + cli/_message-renderer）*/
export function migrateAndValidateSession(
  raw: unknown,
  filename: string,
  audit?: AuditLog,
): SessionData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = raw as Partial<SessionData>;

  // v1 → v2 migration
  if (!parsed.toolsForLLM) {
    (parsed as SessionData).toolsForLLM = [];
    (parsed as SessionData).version = SESSION_CURRENT_VERSION;
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_MIGRATE, `file=${filename}`, `from=1`, `to=${SESSION_CURRENT_VERSION}`);
  }
  // unknown version reject
  if (typeof parsed.version === 'number' && parsed.version > SESSION_CURRENT_VERSION) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN, `file=${filename}`,
      `actual=${parsed.version}`, `current=${SESSION_CURRENT_VERSION}`);
    return null;
  }
  return parsed as SessionData;
}
