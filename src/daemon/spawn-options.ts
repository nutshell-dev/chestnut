/**
 * @module L6.Daemon.SpawnOptions
 * daemon spawn specification 唯一 owner（Phase 1464 Step B）。
 *
 * 业务：Daemon 唯一解释 `node` command、daemon entry argv、identity 参数、
 * `DAEMON_LOG`、`CHESTNUT_ROOT` 与 child `cwd` 协议；CLIProcess/Watchdog 只提交
 * daemon identity（ClawId）、agent directory 与 workspace root 三个必要事实，
 * 不再各自复制组装同一份启动协议（旧 7 调用点多轨，drift
 * B.phase1436-pm-types-daemon-entry / B.rev0717-daemon-spawn-spec-duplication）。
 *
 * 边界：纯函数、零 I/O、零 spawn、不持状态；返回 ProcessManager 通用
 * `SpawnOptions` 即本 capability 成功点，不代表 generation 已提交或 child 已
 * ready（spawn/ready/stop lifecycle 仍归 ProcessManager；`daemonDir` 推导仍归
 * ClawTopology；何时启动/重启仍归 CLIProcess/Watchdog）。同步构造/entry
 * resolution 错误原样上抛，无部分提交、无恢复动作。
 */

import * as path from 'path';
import type { ClawId } from '../foundation/claw-identity/index.js';
import type { SpawnOptions } from '../foundation/process-manager/index.js';
import { DAEMON_LOG } from './constants.js';
import { resolveDaemonEntry } from './entry-resolver.js';

/** daemon spawn specification 最小输入：跨模块只传三个必要事实。 */
export interface DaemonSpawnOptionsInput {
  /** daemon identity（调用方在边界处显式 makeClawId，helper 不接受 raw string）。 */
  clawId: ClawId;
  /** agent directory（clawDir / motionDir）；daemon stdout log 落其下 DAEMON_LOG。 */
  agentDir: string;
  /** workspace root；同时作为 child CHESTNUT_ROOT env 与显式 cwd（协议收敛单轨）。 */
  workspaceRoot: string;
}

export function createDaemonSpawnOptions(input: DaemonSpawnOptionsInput): SpawnOptions {
  return {
    command: 'node',
    args: [resolveDaemonEntry(), input.clawId],
    logFile: path.join(input.agentDir, DAEMON_LOG),
    env: { ...process.env, CHESTNUT_ROOT: input.workspaceRoot },
    cwd: input.workspaceRoot,
  };
}
