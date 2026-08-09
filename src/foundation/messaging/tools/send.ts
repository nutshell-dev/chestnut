/**
 * @module L2c.Messaging
 * send tool - Send message to outbox
 */

import type { Tool, ExecContext } from '../../tools/index.js';
import { formatErr } from "../../node-utils/index.js";
import type { ToolResult } from '../../tool-protocol/index.js';
import type { OutboxWriter } from '../outbox-writer.js';

export const SEND_TOOL_NAME = 'send' as const;

/**
 * phase 520: defaultTarget 由 caller 注入（foundation 不 import MOTION_CLAW_ID、owner=core/claw-topology）。
 * phase 1160: send 工具对外只暴露 content，内部固定 type='report' 以满足 OutboxWriteOptions
 * 的必填约束；priority 由 outbox-writer 内部兜底为 'normal'，不再从外部读取。
 */
export function createSendTool(outboxWriter: OutboxWriter, defaultTarget: string): Tool {
  return {
    name: SEND_TOOL_NAME,
    profiles: ['full'],
    description: 'Send a message to the outbox for the parent.',
    schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Message content',
        },
      },
      required: ['content'],
    },
    readonly: false,
    idempotent: false,

    async execute(args: Record<string, unknown>, _ctx: ExecContext): Promise<ToolResult> {
      const content = args.content as string;

      try {
        await outboxWriter.write({
          type: 'report',
          to: defaultTarget,
          content,
        });

        return {
          success: true,
          content: 'Message sent',
        };
      } catch (error) {
        return {
          success: false,
          content: `Error sending message: ${formatErr(error)}`,
        };
      }
    },
  };
}
