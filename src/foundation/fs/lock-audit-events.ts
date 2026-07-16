/**
 * Lock protocol audit event names.
 *
 * Module-owned event namespace per H1 design (phase345 / B.p336-1 治理).
 * 字符串值与起步态等价 / 0 漂移。
 */
export const LOCK_AUDIT_EVENTS = {
  CLAIM_STALE_RECOVERED: 'lock_claim_stale_recovered',
  CLAIM_ELECTION_LOST: 'lock_claim_election_lost',
} as const;
