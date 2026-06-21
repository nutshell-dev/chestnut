import { formatErr } from "../../utils/index.js";
/**
 * @module L2.Messaging
 * notify_claw tool - motion 视角、向 target claw inbox 直接发消息（指挥型 push 模型）
 *
 * design：l2_messaging.md §10.2、phase 477 sharpen、phase 822 实施
 * profile：motion-only（D11 motion 单向访问特权 derive）
 * vs send：send 写自己 outbox（claw → motion 汇报 pull）/ notify_claw 写他人 inbox（motion → claw 指挥 push）/ 物理操作不同、§10.3 不对称设计登记
 */

import type { Tool, ExecContext, ToolPermissions } from '../../tools/index.js';

import type { ToolResult } from '../../tool-protocol/index.js';
import type { FileSystem } from '../../fs/types.js';
import type { AuditLog } from '../../audit/index.js';
import { notifyClaw } from '../notify.js';
import { MESSAGING_AUDIT_EVENTS } from '../audit-events.js';
export const NOTIFY_CLAW_TOOL_NAME = 'notify_claw' as const;

export interface NotifyClawDeps {
  fs: FileSystem;
  chestnutRoot: string;  // phase 90: 去 brand type-only import；motion dir 的父 dir、用于 resolve target claw dir
  /** phase 520: caller 注入（foundation 不 import MOTION_CLAW_ID、owner=core/claw-topology） */
  motionClawId: string;
  audit: AuditLog;        // motion audit（NOTIFY_CLAW_SENT/FAILED emit）
  isClawAlive: (clawId: string) => boolean; // phase 232: status hint callback
  formatClawStatusHint: (clawName: string, isAlive: boolean) => string | undefined; // phase 232: M#1 single source
  clawExists: (clawId: string) => boolean; // phase 241: exist check callback
  hasActiveContract: (clawId: string) => boolean; // phase 241: active contract hint callback
}

export function createNotifyClawTool(deps: NotifyClawDeps): Tool {
  return {
    name: NOTIFY_CLAW_TOOL_NAME,
    profiles: ['full'],
    description: 'Notify a target claw by writing a message directly to its inbox. interrupt=true（默认）= 目标 claw 完成当前 step 后立即中断 react 循环、下一轮 drain 立刻处理本消息 / interrupt=false = 不打扰、等 claw 自然轮询 pull（消息排进 normal priority 队列）。motion-only tool（D11 单向访问特权）。',
    schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target claw id（必填）',
        },
        body: {
          type: 'string',
          description: '消息内容（必填、自然语言文本）',
        },
        type: {
          type: 'string',
          description: '消息类型（可选、默认 message）',
        },
        interrupt: {
          type: 'boolean',
          description: 'true (默认) = step boundary 中断 react 循环 / false = 不打扰、等自然 turn pull',
          default: true,
        },
      },
      required: ['to', 'body'],
    },
    readonly: false,
    idempotent: false,
    group: 'messaging',

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      // phase 1459 α-5: notify_claw 真依赖仅 `ctx.callerLabel` → `ToolPermissions` 子接口 sufficient（motion 单向访问 gate / D11）。
      const perm: ToolPermissions = ctx;
      // Phase 1105: notify_claw is motion-only
      if (perm.callerLabel !== deps.motionClawId) {
        return { success: false, content: 'notify_claw is motion-only' };
      }
      const to = args.to as string;
      const body = args.body as string;
      const type = (args.type as string) ?? 'message';
      const interrupt = (args.interrupt as boolean) ?? true;
      const priority = interrupt ? 'high' : 'normal';

      // phase 895 / audit-2026-05-16 NEW.P0.2: validation guard (mirror read.ts:75 cross-claw guard)
      // 防 LLM 通过 `to` 字段绕 claws/ namespace 或建 orphan claw dir
      if (typeof to !== 'string' || to.includes('/') || to.includes('..') || to === '' || to === '.' || to.startsWith('.')) {
        deps.audit.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
          `claw=${to}`,
          `reason=invalid_claw_id`,
        );
        return { success: false, content: `Failed to notify ${to}: invalid claw id` };
      }

      // phase 241:前置 exist check — target claw 不存在时不调 wrapper、显式失败
      if (!deps.clawExists(to)) {
        deps.audit.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
          `claw=${to}`,
          `reason=claw_not_found`,
        );
        return { success: false, content: `Failed to notify ${to}: claw "${to}" does not exist` };
      }

      try {
        notifyClaw(deps.fs, deps.chestnutRoot, deps.motionClawId, to, {
          type,
          source: deps.motionClawId,
          priority,
          body,
        }, deps.audit);
        deps.audit.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT,
          `claw=${to}`,
          `type=${type}`,
          `interrupt=${interrupt}`,
        );
        const isAlive = deps.isClawAlive(to);
        const statusHint = deps.formatClawStatusHint(to, isAlive);
        // phase 241: active contract hint — alive but no active contract → remind caller
        const contractHint = isAlive && !deps.hasActiveContract(to)
          ? `No active contract for "${to}". Ask claw to reply via send tool in message body.`
          : undefined;
        const hints = [statusHint, contractHint].filter(Boolean);
        const baseContent = `Notified ${to}: ${type} (interrupt=${interrupt})`;
        const content = hints.length > 0 ? `${baseContent}. ${hints.join('. ')}` : baseContent;
        return {
          success: true,
          content,
        };
      } catch (error) {
        const reason = formatErr(error);
        deps.audit.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
          `claw=${to}`,
          `reason=${reason}`,
        );
        return {
          success: false,
          content: `Failed to notify ${to}: ${reason}`,
        };
      }
    },
  };
}
