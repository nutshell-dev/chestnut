import { describe, it, expect } from 'vitest';
import {
  AggregatedIdNamingMap,
  lookupByAuditCol,
  type IdNamingEntry,
} from '../../src/assembly/id-naming-aggregator.js';

describe('id-naming-aggregator (phase 140 Step C)', () => {
  it('aggregates 4 owner ID_NAMING maps', () => {
    const names = Object.keys(AggregatedIdNamingMap);
    expect(names).toContain('trace');
    expect(names).toContain('step');
    expect(names).toContain('contract');
    expect(names).toContain('subtask');
    expect(names).toContain('turn');
    expect(names).toContain('toolUse');
  });

  it('all entries have non-empty auditCol / tsField / cliFlag', () => {
    for (const [name, entry] of Object.entries(AggregatedIdNamingMap)) {
      expect(entry.auditCol).toMatch(/^[a-z_]+$/);
      expect(entry.tsField).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(typeof entry.cliFlag).toBe('string');
      expect(entry.cliFlag.length).toBeGreaterThan(0);
      expect(name).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });

  it('auditCol values are unique', () => {
    const auditCols = Object.values(AggregatedIdNamingMap).map((e: IdNamingEntry) => e.auditCol);
    expect(new Set(auditCols).size).toBe(auditCols.length);
  });

  it('tsField values are unique', () => {
    const tsFields = Object.values(AggregatedIdNamingMap).map((e: IdNamingEntry) => e.tsField);
    expect(new Set(tsFields).size).toBe(tsFields.length);
  });

  it('lookupByAuditCol returns correct id names', () => {
    expect(lookupByAuditCol('trace_id')).toBe('trace');
    expect(lookupByAuditCol('tool_use_id')).toBe('toolUse');
    expect(lookupByAuditCol('contract_id')).toBe('contract');
    expect(lookupByAuditCol('subtask_id')).toBe('subtask');
    expect(lookupByAuditCol('step')).toBe('step');
    expect(lookupByAuditCol('turn')).toBe('turn');
  });

  it('lookupByAuditCol returns undefined for unknown col', () => {
    expect(lookupByAuditCol('nonexistent_col')).toBeUndefined();
  });

  it('toolUse auditCol matches runtime tool_result col schema naming', () => {
    // Cross-check: llm-provider ID_NAMING.toolUse.auditCol 必须等于 runtime tool_result cols 中的字面
    const toolUse = (AggregatedIdNamingMap as Record<string, IdNamingEntry>).toolUse;
    expect(toolUse.auditCol).toBe('tool_use_id');
  });
});
