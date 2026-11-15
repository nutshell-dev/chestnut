/**
 * @module L4.ContractSystem.ExecutorSupervisor.RecoveryState
 * Phase 2155 Step B4: per-claw durable recovery intent/backoff/circuit。
 *
 * 本 job 独占 status/executor-supervisor-recovery.json。所有路径均相对注入的
 * per-claw FileSystem；读失败/损坏显式 unreadable，绝不猜成首次运行。
 */
import {
  isFileNotFound,
  type AtomicWriteResult,
  type FileSystem,
} from '../../../../foundation/fs/index.js';
import { formatErr } from '../../../../foundation/node-utils/index.js';

export const SUPERVISOR_RECOVERY_STATE_FILE = 'status/executor-supervisor-recovery.json' as const;

/** 模块自有版本化策略；不借用 cron 周期，也不新增 config 字段。 */
export const SUPERVISOR_RECOVERY_POLICY = {
  baseBackoffMs: 30_000,
  maxBackoffMs: 5 * 60_000,
  maxAttempts: 5,
} as const;

export type SupervisorRecoveryIntent = 'ensure' | 'restart';

/**
 * action_succeeded 是成功动作与 state clear 之间的持久屏障：clear 失败后，
 * 下一 tick 只复核清理，不依据旧失败 intent 重放 ensure/restart。
 */
export interface SupervisorRecoveryState {
  schema_version: 1;
  claw_id: string;
  intent: SupervisorRecoveryIntent;
  attempt: number;
  first_failed_at: number;
  last_failed_at: number;
  next_attempt_at: number;
  circuit: 'closed' | 'open';
  last_error: string;
  status: 'retrying' | 'action_succeeded';
}

export type SupervisorRecoveryLoad =
  | { kind: 'missing' }
  | { kind: 'scheduled'; state: SupervisorRecoveryState }
  | { kind: 'unreadable'; reason: string };

export type SupervisorRecoverySave = AtomicWriteResult;
export type SupervisorRecoveryClear = { kind: 'cleared' | 'already_clear' };

/** per-claw 窄状态能力；实现由 Assembly 注入，tick 不直接依赖 Node fs。 */
export interface SupervisorRecoveryStore {
  load(): Promise<SupervisorRecoveryLoad>;
  save(state: SupervisorRecoveryState): Promise<SupervisorRecoverySave>;
  clear(): Promise<SupervisorRecoveryClear>;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateState(value: unknown, rawClawId: string): SupervisorRecoveryState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (
    state.schema_version !== 1
    || state.claw_id !== rawClawId
    || (state.intent !== 'ensure' && state.intent !== 'restart')
    || typeof state.attempt !== 'number'
    || !Number.isSafeInteger(state.attempt)
    || state.attempt < 1
    || !isTimestamp(state.first_failed_at)
    || !isTimestamp(state.last_failed_at)
    || !isTimestamp(state.next_attempt_at)
    || state.first_failed_at > state.last_failed_at
    || state.next_attempt_at < state.last_failed_at
    || (state.circuit !== 'closed' && state.circuit !== 'open')
    || typeof state.last_error !== 'string'
    || (state.status !== 'retrying' && state.status !== 'action_succeeded')
  ) return undefined;
  return state as unknown as SupervisorRecoveryState;
}

export function createSupervisorRecoveryStore(
  fs: FileSystem,
  rawClawId: string,
): SupervisorRecoveryStore {
  return {
    async load(): Promise<SupervisorRecoveryLoad> {
      let raw: string;
      try {
        raw = await fs.read(SUPERVISOR_RECOVERY_STATE_FILE);
      } catch (error) {
        if (isFileNotFound(error)) return { kind: 'missing' };
        return { kind: 'unreadable', reason: formatErr(error) };
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const state = validateState(parsed, rawClawId);
        if (!state) return { kind: 'unreadable', reason: 'invalid_schema_version_1' };
        return { kind: 'scheduled', state };
      } catch (error) {
        return { kind: 'unreadable', reason: formatErr(error) };
      }
    },
    save(state: SupervisorRecoveryState): Promise<SupervisorRecoverySave> {
      if (state.claw_id !== rawClawId) {
        return Promise.reject(new Error(`recovery state claw mismatch: ${state.claw_id} != ${rawClawId}`));
      }
      return fs.writeAtomic(SUPERVISOR_RECOVERY_STATE_FILE, JSON.stringify(state, null, 2));
    },
    async clear(): Promise<SupervisorRecoveryClear> {
      try {
        await fs.delete(SUPERVISOR_RECOVERY_STATE_FILE);
        return { kind: 'cleared' };
      } catch (error) {
        if (isFileNotFound(error)) return { kind: 'already_clear' };
        throw error;
      }
    },
  };
}

export interface SupervisorFailureInput {
  clawId: string;
  intent: SupervisorRecoveryIntent;
  now: number;
  error: string;
}

/** 唯一失败 transition；attempt 封顶，open 后在 capped backoff 窗口做半开重试。 */
export function reduceSupervisorFailure(
  previous: SupervisorRecoveryState | undefined,
  failure: SupervisorFailureInput,
): SupervisorRecoveryState {
  const attempt = Math.min(
    (previous?.attempt ?? 0) + 1,
    SUPERVISOR_RECOVERY_POLICY.maxAttempts,
  );
  const delayMs = Math.min(
    SUPERVISOR_RECOVERY_POLICY.baseBackoffMs * 2 ** (attempt - 1),
    SUPERVISOR_RECOVERY_POLICY.maxBackoffMs,
  );
  return {
    schema_version: 1,
    claw_id: failure.clawId,
    intent: failure.intent,
    attempt,
    first_failed_at: previous?.first_failed_at ?? failure.now,
    last_failed_at: failure.now,
    next_attempt_at: failure.now + delayMs,
    circuit: attempt >= SUPERVISOR_RECOVERY_POLICY.maxAttempts ? 'open' : 'closed',
    last_error: failure.error,
    status: 'retrying',
  };
}
