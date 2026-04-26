/**
 * @module L3.Tools
 * TaskScheduler port — async tool scheduling 抽象。
 *
 * SubAgent 与 ToolExecutor 通过本 port 消费调度能力，避免直接 import
 * L4 TaskSystem 类。L4 TaskSystem class 通过 structural typing 自然
 * 满足本接口（无需显式 implements）。
 */

import type { ToolResult } from './executor.js';

export interface TaskScheduler {
  scheduleTool(
    toolName: string,
    execute: () => Promise<ToolResult>,
    clawId: string,
    opts?: {
      isIdempotent?: boolean;
      callerType?: string;
      toolUseId?: string;
    },
  ): Promise<string>;
}
