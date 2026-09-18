import { formatErr } from "../../../foundation/node-utils/index.js";
import { makeExternalAbortError } from '../../../foundation/llm-provider/index.js';
/**
 * @module L4.ClawTopology.NotifyClaw
 * notify_claw tool - motion 视角、向 target claw inbox 直接发消息（指挥型 push 模型）
 *
 * design：l2_messaging.md §10.2、phase 477 sharpen、phase 822 实施
 * profile：motion-only（D11 motion 单向访问特权 derive）
 * vs send：send 写自己 outbox（claw → motion 汇报 pull）/ notify_claw 写他人 inbox（motion → claw 指挥 push）/ 物理操作不同、§10.3 不对称设计登记
 */

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';

import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
import type { ClawNotifyIntent } from '../../../foundation/messaging/index.js';
import type { TopologyEventSink } from '../types.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../foundation/messaging/index.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from '../audit-events.js';
export const NOTIFY_CLAW_TOOL_NAME = 'notify_claw' as const;

interface NotifyClawDeps {
  /**
   * phase 705 / phase 1864 Step C（CT-D2）: caller-provided delivery capability。
   * 发送归 Messaging（createClawNotifier），位置由拓扑 resolver 注入、
   * 本工具只提交意图（source/body/type/interrupt）。
   */
  notifyClaw: (targetClawId: string, intent: ClawNotifyIntent) => Promise<void>;
  /**
   * phase 550: caller-provided source identity for outgoing notifications + 透传 notifyClaw 的源 arg。
   * (e.g. MOTION_CLAW_ID).
   */
  defaultSource: string;
  /**
   * phase 807: caller-provided authorization flag (replaces `isCallerAuthorized(callerLabel)`).
   * true = motion/main registry authorized; false = shadow registry unauthorized.
   */
  authorized?: boolean;
  /** phase 1864 Step I（CT-D12）：最小 sink（NOTIFY_CLAW_* / topology violation 行 emit）。 */
  sink: TopologyEventSink;
  isClawAlive: (clawId: string) => boolean; // phase 232: status hint callback
  formatClawStatusHint: (clawName: string, isAlive: boolean) => string | undefined; // phase 232: M#1 single source
  clawExists: (clawId: string) => boolean; // phase 241: exist check callback
  hasActiveContract: (clawId: string) => boolean; // phase 241: active contract hint callback
}

export function createNotifyClawTool(deps: NotifyClawDeps): Tool {
  const tool: Tool & { authorized?: boolean } = {
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

    async execute(this: Tool & { authorized?: boolean }, args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      // Phase 807: authorization via DI flag (replaces ctx.callerLabel + isCallerAuthorized predicate).
      // 默认 true 保持主 registry 兼容；shadow registry 注入 authorized=false。
      if (this.authorized === false) {
        deps.sink.write(
          CLAW_TOPOLOGY_AUDIT_EVENTS.NOTIFY_CLAW_MOTION_ONLY_VIOLATION,
          `callerClawId=${deps.defaultSource}`,
          'reason=not_motion_chain',
        );
        return { success: false, content: 'notify_claw is motion-only' };
      }
      const to = args.to as string;
      const body = args.body as string;
      const type = (args.type as string) ?? 'message';
      const interrupt = (args.interrupt as boolean) ?? true;

      // phase 895 / audit-2026-05-16 NEW.P0.2: validation guard (mirror read.ts:75 cross-claw guard)
      // 防 LLM 通过 `to` 字段绕 claws/ namespace 或建 orphan claw dir
      if (typeof to !== 'string' || to.includes('/') || to.includes('..') || to === '' || to === '.' || to.startsWith('.')) {
        deps.sink.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
          `claw=${to}`,
          `reason=invalid_claw_id`,
        );
        return { success: false, content: `Failed to notify ${to}: invalid claw id` };
      }

      // phase 943: unified boundary — clawExists throw, notifyClaw throw, and path validation throw
      // are all handled in the same catch block.
      try {
        // phase 241:前置 exist check — target claw 不存在时不调 wrapper、显式失败
        if (!deps.clawExists(to)) {
          deps.sink.write(
            MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
            `claw=${to}`,
            `reason=claw_not_found`,
          );
          return { success: false, content: `Failed to notify ${to}: claw "${to}" does not exist` };
        }

        // phase 1864 Step C（CT-D2）：只提交意图——envelope（type 默认 / priority 派生）归 Messaging。
        await deps.notifyClaw(to, {
          type,
          source: deps.defaultSource,
          interrupt,
          body,
        });
      } catch (error) {
        if (ctx.signal?.aborted) {
          throw makeExternalAbortError(ctx.signal.reason);
        }
        const reason = formatErr(error);
        deps.sink.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_FAILED,
          `claw=${to}`,
          `reason=${reason}`,
        );
        return {
          success: false,
          content: `Failed to notify ${to}: ${reason}`,
        };
      }

      // notify succeeded — audit SENT
      // Phase 943: SENT audit failure must NOT reverse a successful delivery.
      try {
        deps.sink.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_SENT,
          `claw=${to}`,
          `type=${type}`,
          `interrupt=${interrupt}`,
        );
      } catch (auditErr) {
        // Audit failure does NOT invalidate successful delivery.
        // Use fallback logging so operators can still discover the audit gap.
        process.stderr.write(
          `[notify_claw] SENT audit failed after successful delivery to ${to}: ${formatErr(auditErr)}\n`,
        );
      }

      // hint queries (best-effort, separate try/catch)
      const hints: string[] = [];
      try {
        const isAlive = deps.isClawAlive(to);
        const statusHint = deps.formatClawStatusHint(to, isAlive);
        if (statusHint) hints.push(statusHint);
        // phase 241: active contract hint — alive but no active contract → remind caller
        if (isAlive && !deps.hasActiveContract(to)) {
          hints.push(`No active contract for "${to}". Ask claw to reply via send tool in message body.`);
        }
      } catch (hintErr) {
        deps.sink.write(
          MESSAGING_AUDIT_EVENTS.NOTIFY_CLAW_HINT_FAILED,
          `claw=${to}`,
          `reason=${formatErr(hintErr)}`,
        );
      }

      const baseContent = `Notified ${to}: ${type} (interrupt=${interrupt})`;
      const content = hints.length > 0 ? `${baseContent}. ${hints.join('. ')}` : baseContent;
      return {
        success: true,
        content,
      };
    },
    authorized: deps.authorized ?? false,
    restrictedOverrides: { authorized: false },
  };
  return tool;
}
