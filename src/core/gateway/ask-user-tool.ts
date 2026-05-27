/**
 * ask_user 工具 wrapper
 *
 * 薄包装：不藏状态，不反向依赖 Gateway 内部。
 * 注册归调用方（phase146）。
 */

import type { Gateway } from './types.js';
import type { Tool } from '../../foundation/tools/index.js';

export function createAskUserTool(gateway: Gateway): Tool {
  return {
    name: 'ask_user',
    description: '向用户提问并阻塞等待回复。超时（默认 30 分钟）或被中断时返回失败；无实时连接时立即失败。',
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
      },
      required: ['question'],
    },
    readonly: false,
    idempotent: false,
    profiles: ['full'],
    group: 'messaging',
    execute: (args, ctx) => gateway.askUser(String(args.question ?? ''), ctx),
  };
}
