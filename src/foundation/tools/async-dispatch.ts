import type { CallerType } from '../tool-protocol/index.js';

export interface AsyncToolTaskArgs {
  toolName: string;
  args: Record<string, unknown>;
  parentClawDir: string;
  parentClawId: string;
  isIdempotent: boolean;
  maxRetries: number;
  retryCount: number;
  callerType?: CallerType;
  toolUseId?: string;
  /** phase 858：propagate ExecContext.isShadow through async tool dispatch boundary */
  isShadow?: boolean;
}

export type ScheduleAsyncTool = (args: AsyncToolTaskArgs) => Promise<string>;
