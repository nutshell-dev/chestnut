import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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
  // phase 1159 Step E: random-dream completion delivery also uses opts.notifyMotion(message)
  // DI callback. The sender is real, but the balanced-call scanner intentionally does not
  // inspect arbitrary callback invocations.
  'random_dream_completed',      // src/core/memory/random-dream.ts via opts.notifyMotion(msg) DI callback
  // phase 1162 Step D: deep-dream delivery uses opts.notifyClaw(clawId, msg) DI callback.
  // The sender is real, but the balanced-call scanner intentionally does not
  // inspect arbitrary callback invocations.
  'deep_dream',                  // src/core/memory/deep-dream.ts via opts.notifyClaw(clawId, msg) DI callback
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../../src');
const composersIndexPath = path.join(srcDir, 'assembly/guidance/composers/index.ts');

function extractRegisteredTypes(): Set<string> {
  const content = fs.readFileSync(composersIndexPath, 'utf-8');
  const types = new Set<string>();
  // 路径 1：direct register
  for (const m of content.matchAll(/registry\.register\(\s*'([^']+)'/g)) {
    types.add(m[1]);
  }
  // 路径 2（phase 1263 Step C）：CLIProtocol typed binding 注册 —
  // 解析 registerCliGuidance(registry, [ident, ...]) 的 binding import，
  // 从 binding 源文件提取 `type: 'X'` 字面（识别显式贡献，不是简单 allow 缺失）。
  for (const m of content.matchAll(/registerCliGuidance\(\s*registry\s*,\s*\[([^\]]*)\]/g)) {
    for (const ident of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      types.add(extractBindingType(content, ident));
    }
  }
  return types;
}

/** 从 composers/index.ts import 解析 binding 标识符的源文件，提取其 `type: 'X'` 字面。 */
function extractBindingType(indexContent: string, ident: string): string {
  const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'([^']+)'`, 'g');
  for (const m of indexContent.matchAll(importRe)) {
    const names = m[1].split(',').map(s => s.trim());
    if (!names.includes(ident)) continue;
    const bindingPath = path.resolve(path.dirname(composersIndexPath), m[2].replace(/\.js$/, '.ts'));
    const bindingContent = fs.readFileSync(bindingPath, 'utf-8');
    const typeMatch = bindingContent.match(/\btype:\s*'([^']+)'/);
    if (!typeMatch) {
      throw new Error(`cli guidance binding '${ident}' (${path.relative(srcDir, bindingPath)}) lacks a \`type: '...'\` literal`);
    }
    return typeMatch[1];
  }
  throw new Error(`registerCliGuidance binding '${ident}' has no import in composers/index.ts`);
}

/**
 * notifyClaw / notifyInbox 实际调用站点 + InboxWriter.writeSync 直调站点
 * 提取 type 字面量。Balanced-paren scan 避免跨调用 false positive（phase 1419/1426 治学）。
 */
function extractSenderTypes(): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const callRes = [
    /\b(?:notify(?:Claw|Inbox|System))\s*\(/g,
    // phase 1864 Step C（CT-D2）：cross-target 投递归 Messaging notifier
    /\.\s*notify(?:Async|IntentAsync)?\s*\(/g,
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

export { extractSenderTypes, extractRegisteredTypes, extendWithNonSenderScan, NON_SENDER_SCAN_TYPES };
