/**
 * @module L5.Heartbeat
 * phase 1414: Heartbeat 自家 'heartbeat' inbox 消息 formatter。
 *
 * 业务语义 = "心跳消息怎么对 LLM 呈现" + 自家 HEARTBEAT.md checklist 读
 * + 自家 audit on FS 异常（HEARTBEAT_AUDIT_EVENTS.CHECKLIST_READ_FAILED）。
 *
 * phase 1414 derive：原在 Runtime formatInboxMessage case 'heartbeat'、
 * 含 systemFs.read + 自家 audit + 双码 narrow，迁入业主模块（消除
 * Runtime 字面知 Heartbeat 业务、ML#2/#3 真治）。
 *
 * phase 1018 r124 D fork 既有立场保留：
 *   ENOENT (HEARTBEAT.md 未配) silent skip / 非 ENOENT 显式 audit。
 */

import type { MessageFormatter } from '../../foundation/messaging/index.js';
import { formatErr } from "../../foundation/utils/index.js";
import type { FileSystem } from '../../foundation/fs/types.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { HEARTBEAT_AUDIT_EVENTS } from './audit-events.js';

export interface HeartbeatInboxFormatterDeps {
  /** Heartbeat 模块所在 claw 的 systemFs（HEARTBEAT.md 在 claw 根下）*/
  systemFs: FileSystem;
  /** AuditLog（非 ENOENT 时 emit CHECKLIST_READ_FAILED）*/
  audit: AuditLog;
}

export function createHeartbeatInboxFormatter(deps: HeartbeatInboxFormatterDeps): MessageFormatter {
  const { systemFs, audit } = deps;
  return async ({ timestampSec }) => {
    const base = `[system message${timestampSec}] Heartbeat triggered. Please perform a routine check.`;
    try {
      const checklist = (await systemFs.read('HEARTBEAT.md')).trim();
      return checklist ? `${base}\n\n${checklist}` : base;
    } catch (e) {
      // phase 1154 r+ derive: 双码 narrow via foundation helper（FileSystem 抽象层抛 FS_NOT_FOUND）
      if (!isFileNotFound(e)) {
        const code = (e as NodeJS.ErrnoException)?.code;
        audit.write(
          HEARTBEAT_AUDIT_EVENTS.CHECKLIST_READ_FAILED,
          `code=${code ?? 'unknown'}`,
          `error=${formatErr(e)}`,
        );
      }
      return base;
    }
  };
}
