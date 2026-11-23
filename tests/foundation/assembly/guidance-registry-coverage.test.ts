/**
 * phase 1469 invariant: 所有 src 内 inbox sender 投递的 type 字面量必经
 * guidanceRegistry register（含 NO_GUIDANCE sentinel 表态）。
 *
 * Sender 站点（balanced-paren scan）：
 *   - notifyClaw(...) / notifyInbox(...) / ClawNotifier.notify(...) call body 内 type: 'X' 字面量
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
 *
 * phase 1263 Step C: scanner 识别两条显式贡献路径 —
 *   1. `registry.register('type', composer)` direct register（generic / 未迁 CLI composer）；
 *   2. `registerCliGuidance(registry, [binding])` CLIProtocol typed binding 注册
 *      （type 字面解析自 binding 源文件、仍保证全部 message type 显式覆盖）。
 */

import { describe, it, expect } from 'vitest';
import {
  NON_SENDER_SCAN_TYPES,
  extractRegisteredTypes,
  extractSenderTypes,
  extendWithNonSenderScan,
} from '../../helpers/guidance-registry-scan.js';

describe('phase 1469: motion guidance registry coverage invariant', () => {
  it('retired watchdog motion-facing types are not registered in guidanceRegistry (Phase 1396 Step H)', () => {
    const registered = extractRegisteredTypes();
    expect(registered.has('claw_crashed')).toBe(false);
    expect(registered.has('claw_inactivity')).toBe(false);
  });

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
