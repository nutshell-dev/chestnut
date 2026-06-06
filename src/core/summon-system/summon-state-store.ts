import type { FileSystem } from '../../foundation/fs/types.js';
import type { TaskId } from '../async-task-system/types.js';
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';
import type { AuditLog } from '../../foundation/audit/index.js';

const SUMMON_STATE_SUBDIR = 'summon-state';

export interface SummonDecision {
  readonly taskId: TaskId;
  readonly verify: boolean;
  readonly targetClaw?: string;
  readonly mode: 'shadow' | 'mining';
  readonly dispatchedAt: string;
}

export interface SummonStateStore {
  write(decision: SummonDecision): Promise<void>;
  read(taskId: TaskId): Promise<SummonDecision | undefined>;
}

/**
 * SummonDecision 资源管理者。归属 summon-system。
 * 落盘路径 <motionClawDir>/.chestnut/summon-state/<taskId>.json、其他模块零访问入口。
 *
 * ML "每种资源只归属唯一模块"、"持久化一切信息到磁盘"。
 *
 * read 不存在返 undefined：
 * - subagentTaskId 是通用执行身份、CLI 见到时不一定来自 summon（也可能来自 spawn）
 * - 非 summon 路径的 task 没有 SummonDecision、应 pass-through、不拒
 */
export function createSummonStateStore(fs: FileSystem, audit?: AuditLog): SummonStateStore {
  return {
    async write(decision) {
      const relPath = `${SUMMON_STATE_SUBDIR}/${decision.taskId}.json`;
      try {
        await fs.writeAtomic(relPath, JSON.stringify(decision));
      } catch (e) {
        audit?.write(SUMMON_AUDIT_EVENTS.SUMMON_STATE_WRITE_FAILED, `taskId=${decision.taskId}`, `error=${String(e)}`);
        throw e;   // write 失败 → summon 应失败、不能 silent
      }
    },
    async read(taskId) {
      const relPath = `${SUMMON_STATE_SUBDIR}/${taskId}.json`;
      try {
        const content = await fs.read(relPath);
        return JSON.parse(content) as SummonDecision;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return undefined;
        audit?.write(SUMMON_AUDIT_EVENTS.SUMMON_STATE_READ_FAILED, `taskId=${taskId}`, `error=${String(e)}`);
        return undefined;   // 读失败按"无决策"处理、gate 走 pass-through
      }
    },
  };
}
