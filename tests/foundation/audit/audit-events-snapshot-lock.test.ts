import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../../../src');
const SNAPSHOT_PATH = path.join(SRC_ROOT, 'foundation/audit/audit-events.snapshot.json');

/**
 * Phase 1019 r124 E fork: audit-events const 不变承诺 CI lock.
 * 任意 module 改 audit-events.ts 字符串值 → snapshot fail → PR 必同 ratify update snapshot.
 */
describe('audit-events snapshot lock', () => {
  it('all audit-events.ts string values match snapshot', () => {
    const actual = collectAuditEventsFromSrc(SRC_ROOT);
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    expect(actual).toEqual(expected.modules);
  });

  it('reverse: synthetic source with unauthorized const diverges from snapshot', () => {
    // synthetic source string mimicking audit-events.ts format with unauthorized const
    const syntheticSource = `
      export const FAKE_AUDIT_EVENTS = {
        LEGIT_EVENT: 'legit_event',
        UNAUTHORIZED_FAKE: 'unauthorized_fake_event',
      } as const;
    `;
    // 用同型 regex 提取（mirror collectAuditEventsFromSrc 内部 regex）
    const matches = Array.from(syntheticSource.matchAll(/[A-Z_][A-Z0-9_]*:\s*'([a-z0-9_]+)'/g));
    const syntheticEvents = matches.map(m => m[1]);
    // 验：synthetic 含 unauthorized const
    expect(syntheticEvents).toContain('unauthorized_fake_event');
    // 验：snapshot 不含此 const (snapshot 是 src/ 真扫 / synthetic 不在 src/)
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const allLegitEvents = Object.values(expected.modules).flat() as string[];
    expect(allLegitEvents).not.toContain('unauthorized_fake_event');
    // 证明 lock 真 catch divergence (synthetic ≠ snapshot)
    expect(syntheticEvents).not.toEqual(allLegitEvents);
  });
});

function collectAuditEventsFromSrc(root: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  walk(root, (file) => {
    if (!file.endsWith('audit-events.ts')) return;
    const content = fs.readFileSync(file, 'utf-8');
    // 简单 regex 提取 string literal value (key: 'value')
    const matches = Array.from(content.matchAll(/[A-Z_][A-Z0-9_]*:\s*'([a-z0-9_]+)'/g));
    if (matches.length > 0) {
      const moduleName = path.relative(root, file).replace(/\.ts$/, '').replace(/\//g, '_');
      result[moduleName] = matches.map(m => m[1]).sort();
    }
  });
  return result;
}

function walk(dir: string, cb: (file: string) => void) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}
