/**
 * phase 1469 invariant: 所有 src 内 inbox sender 投递的 type 字面量必经
 * guidanceRegistry register（含 NO_GUIDANCE sentinel 表态）。
 *
 * Sender 站点（balanced-paren scan）：
 *   - notifyClaw(...) / routeNotifyClaw(...) / notifyInbox(...) call body 内 type: 'X' 字面量
 *   - InboxWriter.writeSync({ type: 'X', ... }) 直调
 *   - writeInboxAsync(...) call body 内 type: 'X' 字面量
 *   - 三元 `type: cond ? 'X' : 'Y'` 表达式中两 branch 字面量（如 verification_result/rejection）
 *
 * phase 1476 reframe: 原 OUTBOX_ROUTED_TYPES allowlist (报 5 outbox-routed type:
 * report/question/result/error/response) 砍 — outbox-drain cron 已退场（pull 模型替 push）
 * → 这 5 type 不再进 motion inbox（claw outbox 自家累积、motion CLI 拉取消费）。
 *
 * NEW NON_SENDER_SCAN_TYPES allowlist：cron job 用 raw fs.writeAtomic + encodeInbox 写
 * motion inbox 的 type（不经 notifyX/writeSync/writeInboxAsync 调用、不被 scan 抓）。
 *
 * 守 phase 1414/1419/1426 formatter registry sister cluster 同型 — type coverage 必显式、漏注 fail。
 * 反向：future 加新 sender type 必同步 register（NO_GUIDANCE 或 real composer）/ 漏注 invariant fail。
 */

// phase 1476: cron-written types (raw fs.writeAtomic + encodeInbox / 不被 sender scan 抓)
// phase 9: 加 task_result + contract_audit_feedback —
//   - task_result: result-delivery.ts 通过 const baseMsg + writeInboxAsync(fs, ..., baseMsg) 投递、type 字面量
//     在 const decl 内而非 call arg 内、scan 跳；
//   - contract_audit_feedback: contract-auditor.ts 通过 this.deps.inbox.write({...}) API、scan regex
//     不含 inbox.write 调用形态。
//   两者真有 sender、不是 cron-written；scanner 弱点的 honest 标记（未来可加强 scan: const InboxMessage
//   decl + inbox.write API）。
const NON_SENDER_SCAN_TYPES = new Set([
  'claw_outbox_summary',         // src/foundation/cron/jobs/outbox-summary/write.ts via fs.writeAtomic
  'task_result',                 // src/core/async-task-system/result-delivery.ts via const baseMsg
  'contract_audit_feedback',     // src/core/contract/contract-auditor.ts via this.deps.inbox.write
  // phase 19 Step C: verification-notify.ts uses `resolveNotify(ctx)(...)` wrapper for DIP
  // injection point (ctx.notifyClaw ?? defaultNotifyClaw). Scanner regex
  // `\bnotify(?:Claw|Inbox|System)\s*\(` doesn't match the indirected call form.
  // The 3 types ARE registered in composers/index.ts and ARE real senders — just scanner-blind.
  'verification_error',          // src/core/contract/verification-notify.ts via resolveNotify(ctx)(...)
  'verification_rejection',      // src/core/contract/verification-notify.ts via resolveNotify(ctx)(...)
  'verification_result',         // src/core/contract/verification-notify.ts via resolveNotify(ctx)(...)
  // phase 92: random-dream L4 surface 去 chestnutRoot (DI notify callback pattern).
  // type: 'random_dream' 字面量仍在 random-dream.ts，但投递改由 caller-bound
  // notifyMotion callback 执行，scanner 不抓 `notifyMotion(...)` 调用形态。
  'random_dream',                // src/core/memory/random-dream.ts via opts.notifyMotion(msg) DI callback
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
 * notifyClaw / notifyInbox 实际调用站点 + InboxWriter.writeSync 直调站点
 * 提取 type 字面量。Balanced-paren scan 避免跨调用 false positive（phase 1419/1426 治学）。
 */
function extractSenderTypes(): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const callRes = [
    /\b(?:notify(?:Claw|Inbox|System)|routeNotifyClaw)\s*\(/g,
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

/** phase 1476: cron-written types 加入 sender set (raw fs.writeAtomic + encodeInbox 不被 scan 抓) */
function extendWithNonSenderScan(types: Set<string>): Set<string> {
  const extended = new Set(types);
  for (const t of NON_SENDER_SCAN_TYPES) extended.add(t);
  return extended;
}

describe('phase 1469: motion guidance registry coverage invariant', () => {
  it('every inbox sender type literal (incl. cron-written) must be registered in guidanceRegistry', () => {
    const sentMap = extractSenderTypes();
    const sentTypes = extendWithNonSenderScan(new Set(sentMap.keys()));
    const registered = extractRegisteredTypes();
    const unregistered: Array<{ type: string; sites: string[] }> = [];
    for (const t of sentTypes) {
      if (!registered.has(t)) {
        unregistered.push({
          type: t,
          sites: sentMap.get(t) ?? [NON_SENDER_SCAN_TYPES.has(t) ? 'cron-written (raw fs.writeAtomic)' : '(unknown)'],
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

export { extractSenderTypes, extractRegisteredTypes, extendWithNonSenderScan, NON_SENDER_SCAN_TYPES };
