/**
 * @module L2a.ProcessManager.Activation
 *
 * Phase 1873 Step B（daemon-generation-protocol-expanded-locally）：child generation
 * activation 协议归 PM 单一 capability——inspect/比对/stop-intent/ready/activate 的
 * 状态机与恢复规则收口在 owner 内；caller（daemon）只发起调用并消费 typed outcome，
 * 不再展开协议步骤、不解释各 result kind。
 *
 * 语义与迁移前 daemon.ts `activateOwnGeneration` 逐条 1:1（含 reason 文案与副作用序）：
 * env 缺失 → inspect spawning 存在/ID 一致 → spawning pid 事实存在/与传入 pid 一致
 * →（有 startTime 双方可考时）start-time 一致 → 绑定本 generation 的 stop intent
 * （有则 retire spawning + 失败）→ 写 ready 事实 → activate（activated/already_active
 * 均视为成功）。
 */
import {
  activateGeneration,
  hasStopIntentForGeneration,
  inspectSpawning,
  inspectSpawningPid,
  retireGeneration,
  writeReadyFact,
  type ProcessGenerationRecord,
} from './generation.js';
import type { ProcessManagerContext, DaemonDir } from './types.js';
import type { ProcessStartTime } from '../process-exec/index.js';

/** 激活失败阶段（typed 分类，与既有 reason 文案并存——caller 不做语义展开）。 */
export type ChildActivationStage =
  | 'generation_env_missing'
  | 'spawning_not_found'
  | 'generation_id_mismatch'
  | 'spawning_pid_not_found'
  | 'pid_mismatch'
  | 'start_time_mismatch'
  | 'stop_intent'
  | 'ready_write_failed'
  | 'activate_failed';

export type ChildActivationOutcome =
  | { kind: 'activated'; record: ProcessGenerationRecord }
  | { kind: 'failed'; stage: ChildActivationStage; reason: string };

export interface ChildActivationInput {
  /** spawn-generation identity（env CHESTNUT_PROCESS_GENERATION；缺失即失败）。 */
  readonly generationId: string | undefined;
  /** 当前（child）进程 pid。 */
  readonly pid: number;
  /** 当前（child）进程 start-time（平台不可得时 undefined）。 */
  readonly startTime: ProcessStartTime | undefined;
}

export async function activateChildGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  input: ChildActivationInput,
): Promise<ChildActivationOutcome> {
  const { generationId, pid, startTime } = input;
  if (generationId === undefined) {
    return { kind: 'failed', stage: 'generation_env_missing', reason: 'CHESTNUT_PROCESS_GENERATION env missing' };
  }
  const spawning = inspectSpawning(ctx, daemonDir);
  if (spawning.status !== 'ok') {
    return { kind: 'failed', stage: 'spawning_not_found', reason: `spawning generation not found: ${spawning.status}` };
  }
  if (spawning.record.generation_id !== generationId) {
    return { kind: 'failed', stage: 'generation_id_mismatch', reason: 'spawning generation id mismatch' };
  }
  const pidFact = inspectSpawningPid(ctx, daemonDir);
  if (pidFact.status !== 'ok') {
    return { kind: 'failed', stage: 'spawning_pid_not_found', reason: `spawning pid fact not found: ${pidFact.status}` };
  }
  if (pidFact.record.pid !== pid) {
    return { kind: 'failed', stage: 'pid_mismatch', reason: 'spawning pid does not match current process' };
  }
  if (
    startTime !== undefined &&
    pidFact.record.start_time !== undefined &&
    pidFact.record.start_time !== startTime
  ) {
    return { kind: 'failed', stage: 'start_time_mismatch', reason: 'spawning startTime mismatch' };
  }
  // Step F barrier：child 在写 ready / activate 前检查是否有绑定本 generation 的 stop intent。
  if (hasStopIntentForGeneration(ctx, daemonDir, generationId)) {
    retireGeneration(ctx, daemonDir, { generationId }, 'stopped', 'spawning');
    return { kind: 'failed', stage: 'stop_intent', reason: 'stop intent recorded before activation' };
  }
  const ready = await writeReadyFact(ctx, spawning.record, pid, startTime);
  if (ready.kind !== 'written') {
    return { kind: 'failed', stage: 'ready_write_failed', reason: `ready fact write failed: ${ready.kind}` };
  }
  const activation = activateGeneration(ctx, daemonDir, { generationId, pid, startTime });
  if (activation.kind === 'activated' || activation.kind === 'already_active') {
    return { kind: 'activated', record: activation.record };
  }
  return { kind: 'failed', stage: 'activate_failed', reason: `generation activation failed: ${activation.kind}` };
}
