/**
 * send tool - Send message to outbox
 */

import type { Tool, ToolResult, ExecContext } from '../executor.js';
import type { OutboxWriter } from '../../../foundation/messaging/index.js';

export const sendTool: Tool & { outboxWriter?: OutboxWriter } = {
  outboxWriter: undefined,
  name: 'send',
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

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
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
      if (!sendTool.outboxWriter) {
        return {
          success: false,
          content: 'Outbox writer not available',
        };
      }

      await sendTool.outboxWriter.write({
        type: type as 'report' | 'question' | 'result' | 'error',
        to: 'motion',
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
        content: `Error sending message: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
