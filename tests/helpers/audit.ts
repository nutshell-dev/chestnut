import type { AuditLog } from '../../src/foundation/audit/index.js';

/**
 * Test helper: create a mock AuditLog sink that records all written events.
 */
export function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}
