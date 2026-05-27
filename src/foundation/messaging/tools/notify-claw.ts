/**
 * @module L2.Messaging
 * notify_claw tool - motion 视角、向 target claw inbox 直接发消息（指挥型 push 模型）
 *
 * design：l2_messaging.md §10.2、phase 477 sharpen、phase 822 实施
 * profile：motion-only（D11 motion 单向访问特权 derive）
 * vs send：send 写自己 outbox（claw → motion 汇报 pull）/ notify_claw 写他人 inbox（motion → claw 指挥 push）/ 物理操作不同、§10.3 不对称设计登记
 */

import path from 'node:path';
import type { Tool, ExecContext } from '../../tools/index.js';
import { MOTION_CLAW_ID } from '../../../constants.js';
import type { ToolResult } from '../../tool-protocol/index.js';
import type { FileSystem } from '../../fs/types.js';
import type { AuditLog } from '../../audit/index.js';
import { InboxWriter, makeInboxPath } from '../inbox-writer.js';
import { MESSAGING_AUDIT_EVENTS } from '../audit-events.js';
export const NOTIFY_CLAW_TOOL_NAME = 'notify_claw' as const;

export interface NotifyClawDeps {
  fs: FileSystem;
  clawforumRoot: string;  // motion dir 的父 dir、用于 resolve target claw dir
  audit: AuditLog;        // motion audit（NOTIFY_CLAW_SENT/FAILED emit）
}

export function createNotifyClawTool(deps: NotifyClawDeps): Tool {
  return {
    name: NOTIFY_CLAW_TOOL_NAME,
    profiles: ['full'],
    description: 'Notify a target claw by writing a message directly to its inbox. interrupt=true 让 claw 当前 step 完成后立即处理（中断 react 循环）；interrupt=false（默认）等 claw 正常 turn pull。motion-only tool（D11 单向访问特权）。',
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
          description: 'true = 让 target claw 当前 step 完成后立即处理（PriorityInboxInterrupt）/ false（默认）= 等 claw 正常 turn pull',
          default: false,
        },
      },
      required: ['to', 'body'],
    },
    readonly: false,
    idempotent: false,
    group: 'messaging',

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      // Phase 1105: notify_claw is motion-only
      if (ctx.callerLabel !== MOTION_CLAW_ID) {
        return { success: false, content: 'notify_claw is motion-only' };
      }
      const to = args.to as string;
      const body = args.body as string;
      const type = (args.type as string) ?? 'message';
      const interrupt = (args.interrupt as boolean) ?? false;
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

      // phase 895: orphan prevention — target claw root 必由 claw create 流程预建
      // InboxWriter.ensureDirSync 否则静默建 orphan dir 违 DP「不丢弃静默」
      const targetClawRoot = path.join(deps.clawforumRoot, 'claws', to);
      if (!deps.fs.existsSync(targetClawRoot)) {
        deps.audit.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
          `claw=${to}`,
          `reason=claw_not_found`,
        );
        return { success: false, content: `Failed to notify ${to}: claw not found` };
      }

      const targetInboxDir = path.join(targetClawRoot, 'inbox', 'pending');

      try {
        InboxWriter.__internal_create(deps.fs, makeInboxPath(targetInboxDir), deps.audit).writeSync({
          type,
          source: MOTION_CLAW_ID,
          priority,
          body,
        });
        deps.audit.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT,
          `claw=${to}`,
          `type=${type}`,
          `interrupt=${interrupt}`,
        );
        return {
          success: true,
          content: `Notified ${to}: ${type} (interrupt=${interrupt})`,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
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
