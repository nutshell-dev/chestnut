/**
 * phase 1419 invariant: src/ 内任何 notifyClaw / notifyInbox / notifySystem
 * 调用的 `type: 'X'` 字面量必经 Assembly register（含业主 helper 内 register）。
 *
 * 守 phase 1414 应然「业主自家管 message type formatter」+ DP「未经显式不静默」。
 *
 * 反向：future 加新 type 必同步在 业主 inbox-formatter.ts + assemble.ts register /
 * 否则本测 fail（捕 INBOX_UNKNOWN_TYPE audit storm 回归）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../../../src');

const REGISTER_HELPER_FILES = [
  'foundation/messaging/inbox-formatters.ts',
  'watchdog/inbox-formatter.ts',
  'core/contract/inbox-formatters.ts',
  'daemon/inbox-formatter.ts',
  'core/memory/inbox-formatter.ts',
] as const;

function extractRegisteredTypes(): Set<string> {
  const types = new Set<string>();
  const assembleContent = fs.readFileSync(path.join(srcDir, 'assembly/assemble.ts'), 'utf-8');
  // (1) assemble.ts 内 formatterRegistry.register('X', ...) 直接调
  const directMatches = assembleContent.matchAll(/formatterRegistry\.register\(\s*'([^']+)'/g);
  for (const m of directMatches) types.add(m[1]);
  // (2) 业主 helper：仅当 helper 实际被 assemble.ts 调用时其 register('X', ...) 才生效
  for (const rel of REGISTER_HELPER_FILES) {
    const fp = path.join(srcDir, rel);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    // 提 helper file 内 export function registerXxxFormatters
    const helperExports = [...content.matchAll(/export\s+function\s+(register\w+Formatters)\s*\(/g)].map(m => m[1]);
    // 仅当对应 helper 在 assemble.ts 有调用时、其 register 才算生效
    const liveHelpers = helperExports.filter(name => new RegExp(`\\b${name}\\s*\\(`).test(assembleContent));
    if (liveHelpers.length === 0) continue;
    const matches = content.matchAll(/registry\.register\(\s*'([^']+)'/g);
    for (const m of matches) types.add(m[1]);
  }
  return types;
}

/**
 * notifyClaw / notifyInbox / notifySystem 实际调用站点提取。
 * Balanced-paren scan：找 `notifyXxx(` 起、按 paren 深度扫到匹配 `)`、
 * 只在此 slice 内匹配 `type: 'X'` 字面量（防跨调用 false positive，
 * 如 `notifyClaw: (...) => notifyClaw(...)` 后面 ~100 行的 streamWriter.write({type:'X'}）。
 */
function extractSenderTypes(): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const callRe = /\bnotify(?:Claw|Inbox|System)\s*\(/g;

  function recordType(content: string, callStart: number, slice: string, full: string) {
    const typeRe = /\btype\s*:\s*'([^']+)'/g;
    for (const tm of slice.matchAll(typeRe)) {
      const t = tm[1];
      const localIdx = callStart + (tm.index ?? 0);
      const before = content.slice(0, localIdx);
      const line = before.split('\n').length;
      const rel = path.relative(srcDir, full);
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(`${rel}:${line}`);
    }
  }

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const content = fs.readFileSync(full, 'utf-8');
        for (const cm of content.matchAll(callRe)) {
          const openIdx = (cm.index ?? 0) + cm[0].length - 1;  // index of '('
          // skip false positive: object/property `notifyClaw: ...` form (preceding non-whitespace = ':')
          const lookbehind = content.slice(Math.max(0, (cm.index ?? 0) - 3), cm.index ?? 0).trim();
          if (lookbehind.endsWith(':')) continue;
          // balanced-paren scan
          let depth = 1;
          let i = openIdx + 1;
          while (i < content.length && depth > 0) {
            const c = content[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            i++;
          }
          if (depth !== 0) continue;
          const slice = content.slice(openIdx + 1, i - 1);
          recordType(content, openIdx + 1, slice, full);
        }
      }
    }
  }
  walk(srcDir);
  return byType;
}

describe('phase 1419: inbox formatter registry coverage invariant', () => {
  it('every type literal in src/ notifyClaw|notifyInbox|notifySystem callers must be registered', () => {
    const registered = extractRegisteredTypes();
    const senderByType = extractSenderTypes();
    const unregistered: Array<{ type: string; sites: string[] }> = [];
    for (const [t, sites] of senderByType.entries()) {
      if (!registered.has(t)) unregistered.push({ type: t, sites });
    }
    if (unregistered.length > 0) {
      const summary = unregistered
        .map(u => `  - '${u.type}' (sites: ${u.sites.join(', ')})`)
        .join('\n');
      throw new Error(
        `phase 1419 invariant failed — ${unregistered.length} sender type(s) lack a formatter registration:\n${summary}\n` +
          `Add the type to its owner module's inbox-formatter.ts + register helper, ` +
          `then wire the helper in src/assembly/assemble.ts formatterRegistry setup.`,
      );
    }
    expect(unregistered).toEqual([]);
  });

  it('registered set must cover all 13 expected types after phase 1419', () => {
    const registered = extractRegisteredTypes();
    const expected = [
      'user_inbox_message', 'message', 'user_chat',
      'crash_notification', 'claw_inactivity',
      'contract_events', 'verification_result', 'verification_rejection', 'verification_error',
      'startup_check',
      'random_dream', 'deep_dream',
      // 'heartbeat' is motion-only register, not in assemble unconditionally — accept missing
    ];
    const missing = expected.filter(t => !registered.has(t));
    expect(missing).toEqual([]);
  });
});
