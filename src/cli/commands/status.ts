/**
 * `chestnut status` — global overview of chestnut runtime.
 *
 * Phase 1478 重塑：从原全量 claw dump 改为「最重要状态」聚合：
 *   System（watchdog + motion + orphan ⚠）+ Active claws (N / total)
 * 每个 active claw 三行（uptime / last activity / inbox unread）
 *
 * 实现层：本命令仅装配 deps + 调 L5.StatusService.computeForumStatusView +
 * formatForumStatusView。所有数据 view + 文本格式归 status-service 模块 own；
 * phase 1761：FORUM_* audit 触发语义亦归 owner（CLI 只消费结果并格式化）。
 */

import * as path from 'path';
import type { RootConfigReader } from '../../assembly/index.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { resolveDaemonEntry } from '../../daemon/index.js';
import {
  getWatchdogPid,
  isWatchdogAlive,
  getWatchdogEntryPath,
} from '../../watchdog/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { getProcessStartTime } from '../../foundation/process-exec/index.js';
import {
  computeForumStatusView,
  formatForumStatusView,
} from '../../core/status-service/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { createClawTopology } from '../../core/claw-topology/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';

interface StatusCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal'>;
}

export async function statusCommand(deps: StatusCommandDeps): Promise<void> {
  deps.rootConfig.loadGlobal();

  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const baseDir = path.dirname(motionDir);
  const audit = createSystemAudit(deps.fsFactory(baseDir), baseDir);
  const pm = createProcessManagerForCLI({ ...deps, baseDir });

  const watchdogPid = getWatchdogPid(deps.fsFactory);
  const watchdog = {
    pid: typeof watchdogPid === 'number' ? watchdogPid : undefined,
    alive: isWatchdogAlive(deps.fsFactory),
    entryPath: getWatchdogEntryPath(),
  };

  const daemonEntryPath = resolveDaemonEntry();

  const topology = createClawTopology({
    fs: deps.fsFactory(baseDir),
    chestnutRoot: baseDir,
    motionDir,
  });

  const view = await computeForumStatusView({
    fsFactory: deps.fsFactory,
    clawTopology: topology,
    motionDir,
    pm,
    now: () => Date.now(),
    getStartTime: (pid: number) => getProcessStartTime(pid),
    watchdog,
    daemonEntryPath,
    audit,
  });

  for (const line of formatForumStatusView(view)) {
    console.log(line);
  }
}
