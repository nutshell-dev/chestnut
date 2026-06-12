/**
 * phase 1414 invariant: Runtime 不字面持上下游 inbox message type 措辞 / FS 读 / 业主 audit。
 *
 * Targets:
 * - 'crash_notification' 字面（Watchdog L6 业主）→ M#5 反向防护
 * - 'HEARTBEAT.md' 路径（Heartbeat L5 业主）→ M#2/#3 业务归属防护
 * - 'HEARTBEAT_AUDIT_EVENTS' import（Heartbeat L5 业主）→ M#3 audit 归属防护
 *
 * Allowed:
 * - 'inbox' 字面（Runtime 持 inbox drain 业务、不是消息类型措辞）
 * - 'heartbeat' 字面 仅在以下场景（grep 时排除）：注释 / 其他不相干文本
 *
 * NOTE: tests/foundation/grep-based-invariant-test-kit Tier 2 active 模板
 *       (phase 1414 derive: 业主反向防护必 mechanical lint)。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(__dirname, '../../src/core/runtime');

function readAllTs(dir: string): string {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(readAllTs(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
    }
  }
  return out.join('\n');
}

describe('phase 1414 invariant: Runtime 不字面持上下游 inbox 业务', () => {
  it("0 hit for 'crash_notification' literal（Watchdog 业主、M#5 反向防护）", () => {
    const blob = readAllTs(RUNTIME_DIR);
    // 字面字符串（含引号 . 注释也算）/ 简单 includes 即足
    expect(blob.includes("'crash_notification'")).toBe(false);
    expect(blob.includes('"crash_notification"')).toBe(false);
  });

  it("0 hit for 'HEARTBEAT.md' path（Heartbeat 业主 FS 读、M#2/#3 防护）", () => {
    const blob = readAllTs(RUNTIME_DIR);
    expect(blob.includes("'HEARTBEAT.md'")).toBe(false);
    expect(blob.includes('"HEARTBEAT.md"')).toBe(false);
  });

  it('0 hit for HEARTBEAT_AUDIT_EVENTS const import / use（Heartbeat 业主 audit、M#3 防护）', () => {
    const blob = readAllTs(RUNTIME_DIR);
    // 注释里允许"HEARTBEAT_AUDIT_EVENTS"作为 phase 1414 删除证据；
    // 实然 code 不应再 import / 引用此 const。
    // 区分方式：import / 实然引用 匹配 `from '..../audit-events.*'` + 或 `HEARTBEAT_AUDIT_EVENTS\.`
    const importRe = /import\s*\{[^}]*HEARTBEAT_AUDIT_EVENTS[^}]*\}/g;
    const useRe = /HEARTBEAT_AUDIT_EVENTS\.[A-Z_]+/g;
    expect(blob.match(importRe) ?? []).toEqual([]);
    expect(blob.match(useRe) ?? []).toEqual([]);
  });
});
