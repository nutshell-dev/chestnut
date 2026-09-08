/**
 * Phase 1809 Step B (MEMORY-AUDIT-ROUTING-INCOMPLETE): Memory audit event
 * namespace ↔ MEMORY_FILE_ROUTING 双向 parity 专测。
 *
 * 锁定：`MEMORY_AUDIT_EVENTS` 每个事件值都有唯一 routing entry（无漏配），
 * 且 routing 不引用 namespace 之外的事件（无幽灵 key）。双向断言 + 空集合
 * 差异检查（Step B §7：单向检查仍允许幽灵 routing）。编译期穷尽由
 * `Readonly<Record<MemoryAuditEvent, 'audit'>>` key 类型承担，本测试做运行
 * 时锚定（防类型被改回 string 后静默漂移）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MEMORY_AUDIT_EVENTS, MEMORY_FILE_ROUTING } from '../../../src/core/memory/audit-events.js';

const ownerPath = path.join(process.cwd(), 'src/core/memory', 'audit-events.ts');

describe('phase 1809: Memory audit namespace ↔ file routing parity', () => {
  it('每个已定义事件都有 routing entry（无漏配）', () => {
    const eventValues = new Set(Object.values(MEMORY_AUDIT_EVENTS));
    const routedKeys = new Set(Object.keys(MEMORY_FILE_ROUTING));
    expect([...eventValues].filter(v => !routedKeys.has(v))).toEqual([]);
  });

  it('routing 不引用 namespace 之外的事件（无幽灵 key）', () => {
    const eventValues = new Set(Object.values(MEMORY_AUDIT_EVENTS));
    const routedKeys = new Set(Object.keys(MEMORY_FILE_ROUTING));
    expect([...routedKeys].filter(v => !eventValues.has(v as never))).toEqual([]);
  });

  it('routing 无重复目标外的漂移：所有 entry 均归 audit 主文件', () => {
    for (const [, file] of Object.entries(MEMORY_FILE_ROUTING)) {
      expect(file).toBe('audit');
    }
  });

  it('routing key 类型保持收紧（MemoryAuditEvent，不退化回 string）', () => {
    const src = fs.readFileSync(ownerPath, 'utf8');
    expect(src).toContain('Readonly<Record<MemoryAuditEvent,');
    expect(src).not.toMatch(/MEMORY_FILE_ROUTING:\s*Readonly<Record<string,/);
  });
});
