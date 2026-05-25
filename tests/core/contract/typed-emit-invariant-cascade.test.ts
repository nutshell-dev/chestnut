/**
 * Phase 1267 D.1: typed emit invariant cascade lint test
 *
 * Mechanical sweep: every export function emitContract* with contractId
 * in opts signature must have assertContractIdNonEmpty as first body line.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';

describe('phase 1267 D.1: typed emit invariant cascade mechanical lint', () => {
  it('all emitContract* fn with contractId param have assertContractIdNonEmpty first-line guard', async () => {
    const content = await fs.readFile('src/core/contract/audit-emit.ts', 'utf-8');

    // Extract each export function block
    const fnBlocks: Array<{ name: string; header: string; body: string }> = [];
    const exportFnRe = /export function (emitContract[A-Za-z0-9]+)\(/g;

    let m: RegExpExecArray | null;
    while ((m = exportFnRe.exec(content)) !== null) {
      const name = m[1];
      const start = m.index;
      // Find opening brace of function body
      let braceIdx = content.indexOf('): void {\n', start);
      if (braceIdx === -1) continue;
      braceIdx += '): void {\n'.length;

      // Find matching closing brace (next export function or end of file)
      const nextExport = content.indexOf('\nexport function ', braceIdx);
      const endIdx = nextExport === -1 ? content.length : nextExport;

      const header = content.slice(start, braceIdx);
      const body = content.slice(braceIdx, endIdx);
      fnBlocks.push({ name, header, body });
    }

    // Filter to functions whose opts signature contains contractId
    const contractIdFns = fnBlocks.filter(b => /opts:\s*\{[^}]*contractId/.test(b.header));

    // Expect at least 30 functions with contractId (5 pre-existing + 25 new)
    expect(contractIdFns.length).toBeGreaterThanOrEqual(30);

    const missing: string[] = [];
    for (const fn of contractIdFns) {
      const firstLine = fn.body.split('\n')[0];
      const hasGuard = firstLine.includes(`assertContractIdNonEmpty(audit, opts.contractId, '${fn.name}')`);
      if (!hasGuard) {
        missing.push(fn.name);
      }
    }

    expect(missing).toEqual([]);
  });

  it('assertContractIdNonEmpty helper signature accepts string | undefined', async () => {
    const content = await fs.readFile('src/core/contract/audit-emit.ts', 'utf-8');
    expect(content).toMatch(/function assertContractIdNonEmpty\(\n  audit: AuditLog,\n  contractId: string \| undefined,/);
  });
});
