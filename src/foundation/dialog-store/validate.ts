/**
 * @module L2b.DialogStore.Validate
 * 校验 / 迁移。
 *
 * 抽出自 store.ts、dialogstore-auditor §M-01 follow-up（SRP 拆分）。
 * phase 1850 Step F: 公开校验入口统一为单一 `parseSessionData` 结果协议
 * （shape 判定 + 版本裁决 + v1→v2 迁移 + 默认值归一，一次完成）。
 */

import type { Message } from './canonical-message.js';
import type { DialogStoreAuditSink } from './audit-sink.js';
import type { SessionData } from './types.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';

const SESSION_CURRENT_VERSION = 2;

/**
 * phase 1850 Step F: 单一公开校验入口的结果协议。
 * - ok: 归一完成的 SessionData
 * - rejected: future_version（> 当前版，已审计 VERSION_UNKNOWN）/ invalid_shape（非对象或数组）
 */
export type SessionParseOutcome =
  | { kind: 'ok'; session: SessionData }
  | { kind: 'rejected'; reason: 'future_version' | 'invalid_shape' };

/**
 * 默认值归一（内部共享实现；非公开入口，不走 barrel）。
 * 版本裁决（> 当前版 → rejected）由 parseSessionData 唯一承担，此处只处理
 * version <1 / 非整数 → INVARIANT_FAILED 审计 + 回落当前版。
 */
export function normalizeSessionData(
  data: SessionData,
  audit?: DialogStoreAuditSink,
  clawIdFallback?: string,
): SessionData {
  let version: number = data.version ?? SESSION_CURRENT_VERSION;
  if (typeof version !== 'number' || version < 1) {
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
    trace_id: data.trace_id,
  };
}

/**
 * 单一公开校验入口：shape 判定 → 版本裁决 → v1→v2 迁移 → 默认值归一。
 *
 * 版本裁决唯一规则：
 * - `> SESSION_CURRENT_VERSION` → rejected（VERSION_UNKNOWN 审计）；
 * - `<1 / 非整数` → INVARIANT_FAILED 审计 + 回落当前版（归一内）。
 * v1→v2 迁移（缺 toolsForLLM）语义与 VERSION_MIGRATE 审计字符串不变。
 */
export function parseSessionData(
  raw: unknown,
  filename: string,
  audit?: DialogStoreAuditSink,
  clawIdFallback?: string,
): SessionParseOutcome {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'rejected', reason: 'invalid_shape' };
  }
  const parsed = raw as Partial<SessionData>;

  // unknown version reject（phase 1019 r124 E fork）— future 拒绝为唯一答案
  if (typeof parsed.version === 'number' && parsed.version > SESSION_CURRENT_VERSION) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN, `file=${filename}`,
      `actual=${parsed.version}`, `current=${SESSION_CURRENT_VERSION}`);
    return { kind: 'rejected', reason: 'future_version' };
  }
  // v1 → v2 intentional migration (phase 713 logic 保留)
  if (!parsed.toolsForLLM) {
    (parsed as SessionData).toolsForLLM = [];
    (parsed as SessionData).version = SESSION_CURRENT_VERSION;
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_MIGRATE, `file=${filename}`, `from=1`, `to=${SESSION_CURRENT_VERSION}`);
  }
  return { kind: 'ok', session: normalizeSessionData(parsed as SessionData, audit, clawIdFallback) };
}
