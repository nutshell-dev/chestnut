/**
 * Phase 1033 — L1 PROCESS_EXEC_TIMEOUT_MAX_MS align L4 config max
 *
 * Verifies that L1 process-exec timeout ceiling matches L4 tool_timeout_ms
 * schema max, eliminating silent clamp for mainstream caller values.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { PROCESS_EXEC_TIMEOUT_MAX_MS } from '../../../src/foundation/process-exec/index.js';

describe('phase 1033: L1 PROCESS_EXEC_TIMEOUT_MAX_MS align L4 config max', () => {
  it('MAX = 600_000 (align L4 tool_timeout_ms schema max) (反向 1)', () => {
    expect(PROCESS_EXEC_TIMEOUT_MAX_MS).toBe(600_000);
  });

  it('MAX matches L4 config schema max (反向 2: cross-layer consistency)', async () => {
    const schemaPath = new URL(
      '../../../src/foundation/config/schemas.ts',
      import.meta.url
    );
    const schemaSrc = readFileSync(schemaPath, 'utf8');
    expect(schemaSrc).toMatch(/tool_timeout_ms.*max\(600000\)/);
  });
});
