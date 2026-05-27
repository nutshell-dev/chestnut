/**
 * Cross-layer foundation constants (L0)
 *
 * AUDIT_PREVIEW_LEN = audit log preview truncation character count.
 * Previously owned by audit module (phase 982 ratify M#3).
 * Revoked by phase 1278 r136 D fork user ratify α path:
 * ML#5 unidirectional dependency trumps M#3 single-source ownership
 * for cross-layer shared knowledge (transport L1, llm-provider L2,
 * contract/spawn/shadow L4 all depend on this value).
 */
export const AUDIT_PREVIEW_LEN = 100;
