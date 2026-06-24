/**
 * @module L2b.DialogStore
 *
 * phase 1406: regime switch 实质逻辑迁入（per design row
 * A.phase1406-dialogstore-receive-switchregime）。
 *
 * 应然 anchor：M#2 业务语义归属（dialog 重组是 DialogStore 业务、不是循环
 * 服务业务）+ M#3 资源唯一归属（dialog messages + archive + factory 全在
 * DialogStore 持）+ DP「中断可恢复」原子性。
 *
 * 实施立场：保留 audit 命名空间灵活性（caller 注入 `auditEvents` consts），
 * phase 521+539+600+646+1054 audit invariants 不破。
 *
 * 实然 prior：原在 `src/core/runtime/runtime.ts:_performRegimeSwitch` ~80 行
 * 实质逻辑、Runtime 自承担「dialog 资源重组」违反 M#2/#3。
 */

import * as path from 'node:path';
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import type { Message, ToolDefinition } from '../llm-provider/types.js';
import { formatErr } from '../node-utils/index.js';
import { DialogStore } from './store.js';
import { DIALOG_DIR } from './dirs.js';

/** Regime switch 继承策略：identity 变化时 inherited messages 算法。*/
export type RegimeStrategy = 'all' | 'last-turn' | 'none';

/**
 * Audit event const namespace (caller 注入)。
 *
 * 当前 caller 是 Runtime / 使用 `RUNTIME_AUDIT_EVENTS` 命名空间。phase 521
 * 历史立项时挂在 Runtime audit namespace、本次迁移保持兼容（snapshot.json
 * lock 不破）。未来可考虑迁 `DIALOG_AUDIT_EVENTS` 命名空间。
 */
export interface RegimeSwitchAuditEvents {
  REGIME_SWITCH: string;
  REGIME_SWITCH_COMMITTED: string;
  REGIME_SWITCH_FAILED: string;
  REGIME_SWITCH_HARD_FAIL: string;
}

export interface PerformRegimeSwitchOpts {
  /** 继承策略 */
  strategy: RegimeStrategy;
  /** 新 system prompt（caller 已 build） */
  newSystemPrompt: string;
  /** 当前 DialogStore 实例（即将 archive） */
  currentStore: DialogStore;
  /** DialogStore factory（产 new instance for new regime） */
  dialogStoreFactory: () => DialogStore;
  /** 新 regime 的工具列表（caller's toolRegistry 已 format） */
  toolsForLLM: ToolDefinition[];
  /** clawDir（用于 recovery dump path 构造） */
  clawDir: string;
  /** system fs (recovery dump 写入) */
  systemFs: FileSystem;
  /** caller's AuditLog */
  audit: AuditLog;
  /** caller's audit event consts namespace */
  auditEvents: RegimeSwitchAuditEvents;
  /**
   * phase 1443: optional cleanup callback invoked after regime switch commits.
   * Used by Runtime to clear ExecContext.readFileState + delete `<clawDir>/read-state.json`
   * (gate state should track context: regime switch purges dialog context, so it must purge
   * gate state too — otherwise "智能体是决策主体" is violated post-compaction).
   *
   * Failures inside the callback are caller's responsibility (caller handles + audits);
   * regime switch itself succeeds regardless.
   */
  onSwitchComplete?: () => Promise<void>;
}

export interface PerformRegimeSwitchResult {
  newStore: DialogStore;
  inheritedCount: number;
  discardedCount: number;
}

/** phase 521: 'last-turn' 策略 helper / 找最近 'user' role msg / 从那里切片 */
function extractLastTurn(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages.slice(i);
  }
  return messages; // 0 user msg / 全继承
}

/**
 * Regime switch — identity 变化时把当前 dialog session archive + 按策略
 * 构造继承 messages + 产 new DialogStore 实例并 save。
 *
 * Atomicity 保证（phase 600 ratify）：
 * - archive 失败 → REGIME_SWITCH_HARD_FAIL audit + throw（无 partial state）
 * - save 失败 → recovery dump 写入 + REGIME_SWITCH_FAILED(phase=save) + throw
 * - dump 失败 → REGIME_SWITCH_FAILED(phase=save_and_dump) + throw
 *
 * Failed cases throw → caller's `_checkRegimeSwitch` 不更新 `lastIdentityHash`
 * → 下 turn 重试自愈（D7）。
 *
 * Audit field symmetry 保证（phase 646 ratify）：
 *   phase=save 与 phase=save_and_dump 都含 `recovery_path` 字段。
 *
 * @param opts 所有依赖 + audit 命名空间（DI）
 * @returns 新 DialogStore 实例 + 继承/丢弃统计
 */
export async function performRegimeSwitch(
  opts: PerformRegimeSwitchOpts,
): Promise<PerformRegimeSwitchResult> {
  const {
    strategy,
    newSystemPrompt,
    currentStore,
    dialogStoreFactory,
    toolsForLLM,
    clawDir,
    systemFs,
    audit,
    auditEvents,
  } = opts;

  // 1. 加载 oldMessages
  const { session } = await currentStore.load();
  const oldMessages = session.messages;

  // 2. archive 当前 sessionManager（phase 1373 sub-2 fail-fast / 不 silent continue）
  try {
    await currentStore.archive();
  } catch (e) {
    const msg = formatErr(e);
    // phase 595: 加 phase=archive col、与 REGIME_SWITCH_FAILED L174 (phase=save) / L183 (phase=save_and_dump) 对齐
    audit.write(auditEvents.REGIME_SWITCH_HARD_FAIL, `phase=archive`, `reason=${msg}`);
    throw e;
  }

  // 3. 计算 inherited per strategy
  let inherited: Message[];
  switch (strategy) {
    case 'none': inherited = []; break;
    case 'last-turn': inherited = extractLastTurn(oldMessages); break;
    case 'all': inherited = oldMessages; break;
    default: {
      const _exhaustive: never = strategy;
      return _exhaustive;
    }
  }

  // 4. tool_use 悬空 repair（per L5.G4）
  const { repaired } = DialogStore.repair(inherited, {
    interruptionMessage: 'Regime switch: tools may have changed.',
  });

  // 5. prepare newSessionManager（0 fs mutate / verified store.ts:29-41）
  const newSessionManager = dialogStoreFactory();

  // 6. save inherited 到 newSessionManager (atomic critical)
  try {
    await newSessionManager.save({
      systemPrompt: newSystemPrompt,
      messages: repaired,
      toolsForLLM,
    });
  } catch (saveErr) {
    // catch recovery dump (D1+D5 兜底 / 类 phase 586 audit fallback dump 模板)
    const recoveryPath = path.join(clawDir, DIALOG_DIR, `regime-switch-recovery-${Date.now()}.json`);
    try {
      const recoveryData = JSON.stringify({
        systemPrompt: newSystemPrompt,
        repaired,
        original: oldMessages,
        strategy,
        timestamp: new Date().toISOString(),
        reason: formatErr(saveErr),
      }, null, 2);
      await systemFs.writeAtomic(recoveryPath, recoveryData);
      audit.write(
        auditEvents.REGIME_SWITCH_FAILED,
        `phase=save`,
        `recovery_path=${recoveryPath}`,
        `inherited_count=${repaired.length}`,
        `reason=${formatErr(saveErr)}`,
      );
    } catch (dumpErr) {
      // dump 失败的 final fallback：纯 audit / inherited 极端场景丢失
      audit.write(
        auditEvents.REGIME_SWITCH_FAILED,
        `phase=save_and_dump`,
        `recovery_path=${recoveryPath}`,
        `save_reason=${formatErr(saveErr)}`,
        `dump_reason=${formatErr(dumpErr)}`,
        `inherited_count=${repaired.length}`,
      );
    }
    throw saveErr;
  }

  // 7+8. audit 成功（caller 拿 newStore 后自行 sessionManager = newStore commit 替换）
  audit.write(
    auditEvents.REGIME_SWITCH_COMMITTED,
    `strategy=${strategy}`,
    `inherited=${repaired.length}`,
  );
  audit.write(
    auditEvents.REGIME_SWITCH,
    `strategy=${strategy}`,
    `inherited=${repaired.length}`,
    `discarded=${oldMessages.length - repaired.length}`,
  );

  // phase 1443: invoke optional cleanup callback (e.g. Runtime clears readFileState).
  // Caller is responsible for error handling; regime switch itself is already committed.
  if (opts.onSwitchComplete) {
    await opts.onSwitchComplete();
  }

  return {
    newStore: newSessionManager,
    inheritedCount: repaired.length,
    discardedCount: oldMessages.length - repaired.length,
  };
}
