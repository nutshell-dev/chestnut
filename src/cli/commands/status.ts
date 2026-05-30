/**
 * `clawforum status` — global overview of clawforum runtime.
 *
 * Phase 1478 重塑：从原全量 claw dump 改为「最重要状态」聚合：
 *   System（watchdog + motion + orphan ⚠）+ Active claws (N / total)
 * 每个 active claw 三行（uptime / last activity / inbox unread）
 *
 * 实现层：本命令仅装配 deps + 调 L5.StatusService.computeForumStatusView +
 * formatForumStatusView。所有数据 view + 文本格式归 status-service 模块 own。
 */

import * as path from 'path';
import { loadGlobalConfig, getNamedSubrootDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { resolveDaemonEntry } from '../../foundation/paths.js';
import {
  getWatchdogPid,
  isWatchdogAlive,
  getWatchdogEntryPath,
} from '../../watchdog/watchdog.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { getProcessStartTime } from '../../foundation/process-exec/index.js';
import {
  computeForumStatusView,
  formatForumStatusView,
} from '../../core/status-service/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function statusCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const baseDir = path.dirname(motionDir);
  const pm = createProcessManagerForCLI(deps);

  const watchdogPid = getWatchdogPid(deps.fsFactory);
  const watchdog = {
    pid: typeof watchdogPid === 'number' ? watchdogPid : undefined,
    alive: isWatchdogAlive(deps.fsFactory),
    entryPath: getWatchdogEntryPath(deps.fsFactory),
  };

  const nodeFs = deps.fsFactory(process.cwd());
  const daemonEntryPath = resolveDaemonEntry(nodeFs);

  const view = computeForumStatusView({
    fsFactory: deps.fsFactory,
    baseDir,
    motionDir,
    pm,
    now: () => Date.now(),
    getStartTime: (pid: number) => getProcessStartTime(pid),
    watchdog,
    daemonEntryPath,
  });

  for (const line of formatForumStatusView(view)) {
    console.log(line);
  }
}
