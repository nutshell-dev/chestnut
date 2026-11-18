/** Viewport-owned snapshot exclusion and bounded persistence policy. */
export const VIEWPORT_AUDIT_FILE = 'viewport.tsv';
export const VIEWPORT_SNAPSHOT_IGNORE: readonly string[] = [VIEWPORT_AUDIT_FILE];

/** Bounded live file plus a small, expiring archive window for forensic reads. */
export const VIEWPORT_AUDIT_MAX_SIZE_MB = 16;
export const VIEWPORT_AUDIT_RETENTION_DAYS = 30;
export const VIEWPORT_AUDIT_MAX_ARCHIVES = 8;
