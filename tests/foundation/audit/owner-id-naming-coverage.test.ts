import { describe, it, expect } from 'vitest';
import { AggregatedIdNamingMap } from '../../../src/assembly/id-naming-aggregator.js';
import type { IdNamingEntry } from '../../../src/foundation/audit/types.js';

describe('owner id-naming coverage (phase 140 Step C)', () => {
  /**
   * Phase 136 §5.B SoT 表 7 ID 维度：
   * 1. trace   → runtime
   * 2. tool_use → llm-provider
   * 3. step    → runtime
   * 4. turn    → dialog-store
   * 5. contract → contract
   * 6. subtask → contract
   * 7. seq     → audit 模块自含（audit row 自带 seq= col，不在业主声明）
   */
  it('covers 6 of 7 ID dimensions (seq is audit-internal)', () => {
    const auditCols = Object.values(AggregatedIdNamingMap).map((e: IdNamingEntry) => e.auditCol);
    expect(auditCols).toContain('trace_id');
    expect(auditCols).toContain('tool_use_id');
    expect(auditCols).toContain('step');
    expect(auditCols).toContain('turn');
    expect(auditCols).toContain('contract_id');
    expect(auditCols).toContain('subtask_id');
  });

  it('every declared auditCol uses snake_case', () => {
    for (const entry of Object.values(AggregatedIdNamingMap)) {
      expect(entry.auditCol).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('tsField uses camelCase or PascalCase brand names', () => {
    for (const entry of Object.values(AggregatedIdNamingMap)) {
      expect(entry.tsField).toMatch(/^[A-Z][a-zA-Z0-9]*$|^[a-z][a-zA-Z0-9]*$/);
    }
  });

  it('dialogMeta is either snake_case string or null', () => {
    for (const entry of Object.values(AggregatedIdNamingMap)) {
      if (entry.dialogMeta !== null) {
        expect(entry.dialogMeta).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('no duplicate keys across owner maps', () => {
    const keys = Object.keys(AggregatedIdNamingMap);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
