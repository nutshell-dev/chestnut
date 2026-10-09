/**
 * @module L6.Daemon.SpawnOptions
 * daemon spawn specification 唯一 owner（Phase 1464 Step B）。
 *
 * 业务：Daemon 唯一解释 `node` command、daemon entry argv、identity 参数、
 * `DAEMON_LOG`、`CHESTNUT_ROOT` 与 child `cwd` 协议；CLIProcess/Watchdog 只提交
 * daemon identity（ClawId）、agent directory 与实例根（ChestnutRoot）三个必要事实，
 * 不再各自复制组装同一份启动协议（旧 7 调用点多轨，drift
 * B.phase1436-pm-types-daemon-entry / B.rev0717-daemon-spawn-spec-duplication）。
 *
 * Phase 1930 Step B：跨模块只传 ChestnutRoot；child 的 `CHESTNUT_ROOT` env 与
 * `cwd` 保持既有**父目录**外部协议，由本 owner 私有推导（`path.dirname`），
 * 不再要求调用方传可互相矛盾的父目录。
 *
 * 边界：纯函数、零 I/O、零 spawn、不持状态；返回 ProcessManager 通用
 * `SpawnOptions` 即本 capability 成功点，不代表 generation 已提交或 child 已
 * ready（spawn/ready/stop lifecycle 仍归 ProcessManager；`daemonDir` 推导仍归
 * ClawTopology；何时启动/重启仍归 CLIProcess/Watchdog）。同步构造/entry
 * resolution 错误原样上抛，无部分提交、无恢复动作。
 */

import * as path from 'path';
import type { ClawId, ChestnutRoot } from '../foundation/claw-identity/index.js';
import type { SpawnOptions } from '../foundation/process-manager/index.js';
import { DAEMON_LOG } from './constants.js';
import { EXPECTED_LLM_IDENTITY_ENV } from './constants.js';
import { resolveDaemonEntry } from './entry-resolver.js';

/** daemon spawn specification 最小输入：跨模块只传三个必要事实。 */
export interface DaemonSpawnOptionsInput {
  /** daemon identity（调用方在边界处显式 makeClawId，helper 不接受 raw string）。 */
  clawId: ClawId;
  /** agent directory（clawDir / motionDir）；daemon stdout log 落其下 DAEMON_LOG。 */
  agentDir: string;
  /**
   * 实例根（ChestnutRoot）。child `CHESTNUT_ROOT` env 与显式 `cwd` 保持既有
   * 父目录协议，由本 owner 私有推导（协议收敛单轨）。
   */
  chestnutRoot: ChestnutRoot;
  /**
   * Phase 1926 Step C：已通过 probe 的 LLM 配置快照身份（可选）。
   * 仅 start 门控验证成功后注入；daemon 装配前复核，不等即 fail-closed 退出。
   */
  expectedLLMIdentity?: string;
}

export function createDaemonSpawnOptions(input: DaemonSpawnOptionsInput): SpawnOptions {
  // Phase 1930 Step B：实例根 → legacy 父目录 env/cwd 的推导收敛在本 owner；
  // ChestnutRoot 恒为绝对规范路径，child 继承到的父目录恒为绝对值。
  const legacyParent = path.dirname(input.chestnutRoot);
  return {
    command: 'node',
    args: [resolveDaemonEntry(), input.clawId],
    logFile: path.join(input.agentDir, DAEMON_LOG),
    env: {
      ...process.env,
      CHESTNUT_ROOT: legacyParent,
      ...(input.expectedLLMIdentity !== undefined
        ? { [EXPECTED_LLM_IDENTITY_ENV]: input.expectedLLMIdentity }
        : {}),
    },
    cwd: legacyParent,
  };
}
