
import type { ToolUseId } from '../tool-protocol/index.js';

export interface AsyncToolTaskArgs {
  toolName: string;
  args: Record<string, unknown>;
  parentClawDir: string;
  parentClawId: string;
  isIdempotent: boolean;
  maxRetries: number;
  retryCount: number;
  /** phase 1337: opaque audit label (replaces callerType semantic) */
  callerLabel?: string;
  toolUseId?: ToolUseId;
  /** phase 858：propagate ExecContext.isShadow through async tool dispatch boundary */
  isShadow?: boolean;
}

export type ScheduleAsyncTool = (args: AsyncToolTaskArgs) => Promise<string>;
