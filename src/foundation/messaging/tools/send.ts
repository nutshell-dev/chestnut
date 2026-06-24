/**
 * @module L2c.Messaging
 * send tool - Send message to outbox
 */

import type { Tool, ExecContext } from '../../tools/index.js';
import { formatErr } from "../../utils/index.js";
import type { ToolResult } from '../../tool-protocol/index.js';
import type { OutboxWriter } from '../index.js';

export const SEND_TOOL_NAME = 'send' as const;

/**
 * phase 520: defaultTarget 由 caller 注入（foundation 不 import MOTION_CLAW_ID、owner=core/claw-topology）。
 */
export function createSendTool(outboxWriter: OutboxWriter, defaultTarget: string): Tool {
  return {
    name: SEND_TOOL_NAME,
    profiles: ['full'],
    group: 'messaging',
    description: 'Send a message to the outbox for the parent or other claws. Priority: critical|high|normal|low (default: normal).',
    schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Message content',
        },
        type: {
          type: 'string',
          description: 'Message type: report (status update or progress), question (ask parent for input or clarification), result (final task output), error (failure or blocker)',
          enum: ['report', 'question', 'result', 'error'],
        },
        priority: {
          type: 'string',
          description: 'Message priority: critical|high|normal|low (default: normal)',
          enum: ['critical', 'high', 'normal', 'low'],
          default: 'normal',
        },
      },
      required: ['content', 'type'],
    },
    readonly: false,
    idempotent: false,

    async execute(args: Record<string, unknown>, _ctx: ExecContext): Promise<ToolResult> {
      const content = args.content as string;
      const type = args.type as string;
      const priority = (args.priority as string) ?? 'normal';

      // Validate type
      const validTypes = ['report', 'question', 'result', 'error'];
      if (!validTypes.includes(type)) {
        return {
          success: false,
          content: `Invalid message type: ${type}. Must be one of: ${validTypes.join(', ')}`,
        };
      }

      // Validate priority
      const validPriorities = ['critical', 'high', 'normal', 'low'];
      if (!validPriorities.includes(priority)) {
        return {
          success: false,
          content: `Invalid priority: ${priority}. Must be one of: ${validPriorities.join(', ')}`,
        };
      }

      try {
        await outboxWriter.write({
          type: type as 'report' | 'question' | 'result' | 'error',
          to: defaultTarget,
          content,
          priority: priority as 'critical' | 'high' | 'normal' | 'low',
        });

        return {
          success: true,
          content: `Message sent: ${type}`,
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
