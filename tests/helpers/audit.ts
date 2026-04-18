import type { Audit } from '../../src/foundation/audit/index.js';

/**
 * Test helper: create a mock Audit sink that records all written events.
 */
export function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: Audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}
