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
 * AUDIT_PREVIEW_LEN = audit log 预览字段截断字符数
 * （audit 体系内部、raw/intent/task 等预览字段统一截断长度）
 * 与 AUDIT_MESSAGE_MAX_CHARS 区别：
 *   - AUDIT_PREVIEW_LEN (100) = preview / debug 用、短摘要
 *   - AUDIT_MESSAGE_MAX_CHARS (200) = 单字段完整 truncate cap、防 binary payload 撑爆
 */
export const AUDIT_PREVIEW_LEN = 100;
