/**
 * Phase 1267 D.1: typed emit invariant cascade lint test
 *
 * 主 sweep (`emitContract*` 含 contractId opts 必首行 guard) 已迁 ESLint custom
 * rule `chestnut-custom/typed-emit-cascade-first-line-guard` (phase 424)。
 *
 * 本 file 仅留 #2 positive presence (assertContractIdNonEmpty helper signature)
 * — ESLint 不擅长 positive contract verification。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';

describe('phase 1267 D.1: assertContractIdNonEmpty helper signature positive (phase 424 缩 vitest)', () => {
  it('assertContractIdNonEmpty helper signature accepts string | undefined', async () => {
    const content = await fs.readFile('src/core/contract/audit-emit.ts', 'utf-8');
    expect(content).toMatch(/function assertContractIdNonEmpty\(\n  audit: AuditLog,\n  contractId: string \| undefined,/);
  });
});
