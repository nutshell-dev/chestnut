/**
 * phase 1469 invariant: 所有 src 内 inbox sender 投递的 type 字面量必经
 * guidanceRegistry register（含 NO_GUIDANCE sentinel 表态）。
 *
 * Sender 站点（balanced-paren scan）：
 *   - notifyClaw(...) / notifyInbox(...) / notifySystem(...) call body 内 type: 'X' 字面量
 *   - InboxWriter.writeSync({ type: 'X', ... }) 直调
 *   - writeInboxAsync(...) call body 内 type: 'X' 字面量
 *   - 三元 `type: cond ? 'X' : 'Y'` 表达式中两 branch 字面量（如 verification_result/rejection）
 *
 * Outbox-routed types（report/question/result/error/response）由 send tool / Runtime _writeErrorResponse 写自家 outbox、
 * 经 drain-outboxes cron 路由到 motion inbox / type 透传 — 不在 sender scan 直接命中、但必须 register。
 * 加 outbox-routed allowlist 显式声明这部分。
 *
 * 守 phase 1414/1419/1426 formatter registry sister cluster 同型 — type coverage 必显式、漏注 fail。
 * 反向：future 加新 sender type 必同步 register（NO_GUIDANCE 或 real composer）/ 漏注 invariant fail。
 */

// Outbox-routed types：send tool + Runtime response（drain-outboxes 路由到 inbox / type 透传）
const OUTBOX_ROUTED_TYPES = new Set([
  'report', 'question', 'result', 'error', 'response',
]);

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../../../src');
const composersIndexPath = path.join(srcDir, 'assembly/guidance/composers/index.ts');

function extractRegisteredTypes(): Set<string> {
  const content = fs.readFileSync(composersIndexPath, 'utf-8');
  const matches = content.matchAll(/registry\.register\(\s*'([^']+)'/g);
  return new Set([...matches].map(m => m[1]));
}

/**
 * notifyClaw / notifyInbox / notifySystem 实际调用站点 + InboxWriter.writeSync 直调站点
 * 提取 type 字面量。Balanced-paren scan 避免跨调用 false positive（phase 1419/1426 治学）。
 */
function extractSenderTypes(): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const callRes = [
    /\bnotify(?:Claw|Inbox|System)\s*\(/g,
    /\.\s*writeSync\s*\(/g,
    /\bwriteInboxAsync\s*\(/g,
  ];

  function scanSlice(content: string, sliceStart: number, slice: string, full: string): void {
    // 直接 `type: 'X'` 字面量
    for (const tm of slice.matchAll(/\btype\s*:\s*'([^']+)'/g)) {
      record(content, sliceStart + (tm.index ?? 0), tm[1], full);
    }
    // 三元 `type: cond ? 'X' : 'Y'` 两 branch
    for (const tm of slice.matchAll(/\btype\s*:\s*[^,]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
      const idx = tm.index ?? 0;
      record(content, sliceStart + idx, tm[1], full);
      record(content, sliceStart + idx, tm[2], full);
    }
  }

  function record(content: string, idx: number, t: string, full: string): void {
    const before = content.slice(0, idx);
    const line = before.split('\n').length;
    const rel = path.relative(srcDir, full);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(`${rel}:${line}`);
  }

  function scanCall(content: string, callMatch: RegExpMatchArray, full: string): void {
    const lookbehind = content.slice(Math.max(0, (callMatch.index ?? 0) - 3), callMatch.index ?? 0).trim();
    if (lookbehind.endsWith(':')) return;   // skip property/decl form
    const openIdx = (callMatch.index ?? 0) + callMatch[0].length - 1;
    let depth = 1;
    let i = openIdx + 1;
    while (i < content.length && depth > 0) {
      const c = content[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (depth !== 0) return;
    const slice = content.slice(openIdx + 1, i - 1);
    scanSlice(content, openIdx + 1, slice, full);
  }

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 guidance composers 自身（不算 sender）
        if (full.includes('assembly/guidance')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const content = fs.readFileSync(full, 'utf-8');
        for (const re of callRes) {
          for (const cm of content.matchAll(re)) {
            scanCall(content, cm, full);
          }
        }
      }
    }
  }
  walk(srcDir);
  return byType;
}

/** Outbox-routed types 加入 sender set（drain-outboxes 路由到 inbox / 透传）*/
function extendWithOutboxRouted(types: Set<string>): Set<string> {
  const extended = new Set(types);
  for (const t of OUTBOX_ROUTED_TYPES) extended.add(t);
  return extended;
}

describe('phase 1469: motion guidance registry coverage invariant', () => {
  it('every inbox sender type literal (incl. outbox-routed) must be registered in guidanceRegistry', () => {
    const sentMap = extractSenderTypes();
    const sentTypes = extendWithOutboxRouted(new Set(sentMap.keys()));
    const registered = extractRegisteredTypes();
    const unregistered: Array<{ type: string; sites: string[] }> = [];
    for (const t of sentTypes) {
      if (!registered.has(t)) {
        unregistered.push({
          type: t,
          sites: sentMap.get(t) ?? [OUTBOX_ROUTED_TYPES.has(t) ? 'outbox-routed (drain-outboxes)' : '(unknown)'],
        });
      }
    }
    if (unregistered.length > 0) {
      const summary = unregistered
        .map(u => `  - '${u.type}' sites: ${u.sites.join(', ')}`)
        .join('\n');
      throw new Error(
        `phase 1469 invariant failed — ${unregistered.length} sender type(s) lack registration in guidanceRegistry:\n${summary}\n` +
          `Add register call (with NO_GUIDANCE sentinel for P3 types, or real composer) to ` +
          `src/assembly/guidance/composers/index.ts → registerAllMotionGuidance().`,
      );
    }
    expect(unregistered).toEqual([]);
  });
});

export { extractSenderTypes, extractRegisteredTypes, extendWithOutboxRouted, OUTBOX_ROUTED_TYPES };
