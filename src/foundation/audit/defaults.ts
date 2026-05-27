/**
 * Audit 模块行为默认值 const
 * phase 749 物理迁自 src/constants.ts、M#3 资源唯一归属合规
 * mirror phase 745+746+747+748 owner module barrel 模板 N=5
 *
 * AUDIT_MESSAGE_MAX_CHARS = audit log 单字段最大字符数
 * caller 写 audit 前主动 slice（β-pragmatic、α audit.write API 内化推 r+1+ phase）
 */
export const AUDIT_MESSAGE_MAX_CHARS = 200;

/**
 * AUDIT_PREVIEW_LEN — SUNSET backward-compat re-export (phase 1278 α path)
 *
 * Original const ratified at phase 982 (M#3 + ML#8 single-source).
 * Revoked by phase 1278 r136 D fork user ratify α path:
 * moved to foundation/constants.ts (L0) to eliminate L1→L2a reverse import
 * and same-layer L2→L2a cross-module dependency.
 *
 * This re-export is retained for 30-day backward compat.
 * Audit emit `AUDIT_PREVIEW_LEN_LEGACY_BARREL_IMPORT` tracked.
 * After sunset: delete this re-export; all callers must import from
 * `foundation/constants.js` directly.
 */
export { AUDIT_PREVIEW_LEN } from '../constants.js';
