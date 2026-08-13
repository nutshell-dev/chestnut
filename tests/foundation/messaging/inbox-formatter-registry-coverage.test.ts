/**
 * phase 1419 / 1243 invariant: src/ 内任何 notifyClaw / notifyInbox
 * 调用的 `type: 'X'` 字面量必经 owner declaration 注册。
 *
 * 守 phase 1243 应然「业主自家管 message type rendering declaration」+ DP「未经显式不静默」。
 *
 * 反向：future 加新 type 必同步在 owner inbox-formatter.ts declaration 数组 /
 * 否则本测 fail（捕 INBOX_UNKNOWN_TYPE audit storm 回归）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../../../src');

const DECLARATION_FILES = [
  'foundation/messaging/inbox-formatters.ts',
  'core/gateway/inbox-formatter.ts',
  'watchdog/inbox-formatter.ts',
  'core/contract/inbox-formatters.ts',
  'daemon/inbox-formatter.ts',
  'core/memory/inbox-formatter.ts',
  'core/async-task-system/inbox-formatter.ts',
] as const;

function extractRegisteredTypes(): Set<string> {
  const types = new Set<string>();
  // owner declarations
  for (const rel of DECLARATION_FILES) {
    const fp = path.join(srcDir, rel);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf-8');
    // owner declaration 文件内 `type: 'X'` 即注册 type
    const matches = content.matchAll(/type\s*:\s*'([^']+)'/g);
    for (const m of matches) types.add(m[1]);
  }
  // Assembly 直接 register 调用（含 motion-only heartbeat custom formatter）
  const assembleContent = fs.readFileSync(path.join(srcDir, 'assembly/assemble.ts'), 'utf-8');
  const businessContent = fs.readFileSync(path.join(srcDir, 'assembly/business-systems.ts'), 'utf-8');
  const assemblyContent = assembleContent + businessContent;
  const directMatches = assemblyContent.matchAll(/formatterRegistry\.register\(\s*\{\s*type:\s*'([^']+)'/g);
  for (const m of directMatches) types.add(m[1]);
  return types;
}

/**
 * notifyClaw / notifyInbox 实际调用站点提取。
 * Balanced-paren scan：找 `notifyXxx(` 起、按 paren 深度扫到匹配 `)`、
 * 只在此 slice 内匹配 `type: 'X'` 字面量（防跨调用 false positive，
 * 如 `notifyClaw: (...) => notifyClaw(...)` 后面 ~100 行的 streamWriter.write({type:'X'}）。
 */
function extractSenderTypes(): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const callRe = /\bnotify(?:Claw|Inbox)\s*\(/g;

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

describe('phase 1419/1243: inbox message type registry coverage invariant', () => {
  it('every type literal in src/ notifyClaw|notifyInbox callers must be registered', () => {
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
        `phase 1419/1243 invariant failed — ${unregistered.length} sender type(s) lack a rendering declaration:\n${summary}\n` +
          `Add the type to its owner module's inbox-formatter.ts declaration array.`,
      );
    }
    expect(unregistered).toEqual([]);
  });

  it('registered set must cover expected types after phase 9', () => {
    const registered = extractRegisteredTypes();
    const expected = [
      'user_inbox_message', 'user_chat',
      'claw_inactivity',
      'contract_events', 'verification_result', 'verification_rejection', 'verification_error',
      'startup_check',
      'random_dream', 'deep_dream',
      // phase 9: 'message' catch-all 拆为 4 typed event
      'task_result', 'contract_created', 'contract_resume', 'contract_audit_feedback',
      // 'heartbeat' is motion-only register, not in declaration files — accept missing
    ];
    const missing = expected.filter(t => !registered.has(t));
    expect(missing).toEqual([]);
  });

  /**
   * phase 1426: 在 phase 1419 base 上加 NEW assertion — notifyClaw/notifyInbox
   * call body 内 `type:` 字段不得为含 `${}` 插值的模板字符串。
   */
  it('phase 1426: type field in notifyClaw|notifyInbox call body must not be an interpolated template literal', () => {
    type Violation = { site: string; preview: string };
    const violations: Violation[] = [];
    const callRe = /\bnotify(?:Claw|Inbox)\s*\(/g;

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf-8');
          for (const cm of content.matchAll(callRe)) {
            const lookbehind = content.slice(Math.max(0, (cm.index ?? 0) - 3), cm.index ?? 0).trim();
            if (lookbehind.endsWith(':')) continue;
            const openIdx = (cm.index ?? 0) + cm[0].length - 1;
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
            for (const tm of slice.matchAll(/\btype\s*:\s*([^,}\n]+)/g)) {
              const raw = tm[1].trim();
              if (raw.startsWith('`') && raw.includes('${')) {
                const before = content.slice(0, openIdx + 1 + (tm.index ?? 0));
                const line = before.split('\n').length;
                const rel = path.relative(srcDir, full);
                const preview = raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
                violations.push({ site: `${rel}:${line}`, preview });
              }
            }
          }
        }
      }
    }
    walk(srcDir);

    if (violations.length > 0) {
      const summary = violations.map(v => `  - ${v.site}: ${v.preview}`).join('\n');
      throw new Error(
        `phase 1426 invariant failed — ${violations.length} interpolated template literal type value(s) in notifyXxx call body:\n${summary}\n` +
          `Replace with a single-quoted string literal so phase 1419/1243 registry-coverage invariant can verify declaration registration.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
