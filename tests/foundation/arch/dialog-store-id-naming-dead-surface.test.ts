import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditEventsSource = readFileSync(
  new URL('../../../src/foundation/dialog-store/audit-events.ts', import.meta.url),
  'utf8',
);

describe('DialogStore DIALOG_ID_NAMING dead surface', () => {
  it('does not retain the zero-caller id naming map', () => {
    expect(auditEventsSource).not.toMatch(/\bDIALOG_ID_NAMING\b/);
  });
});
