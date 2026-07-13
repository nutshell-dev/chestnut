/**
 * `chestnut status` — global overview of chestnut runtime.
 *
 * Phase 1478 重塑：从原全量 claw dump 改为「最重要状态」聚合：
 *   System（watchdog + motion + orphan ⚠）+ Active claws (N / total)
 * 每个 active claw 三行（uptime / last activity / inbox unread）
 *
 * 实现层：本命令仅装配 deps + 调 L5.StatusService.computeForumStatusView +
 * formatForumStatusView。所有数据 view + 文本格式归 status-service 模块 own。
 */

import * as path from 'path';
import { loadGlobalConfig } from '../../assembly/config/config-load.js';
import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { resolveDaemonEntry } from '../../assembly/spawn-entry.js';
import {
  getWatchdogPid,
  isWatchdogAlive,
  getWatchdogEntryPath,
} from '../../watchdog/watchdog.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { getProcessStartTime } from '../../foundation/process-exec/index.js';
import {
  computeForumStatusView,
  formatForumStatusView,
} from '../../core/status-service/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { createClawTopology } from '../../core/claw-topology/index.js';
import { createSystemAudit } from '../../foundation/audit/index.js';

export async function statusCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Promise<void> {
  loadGlobalConfig(deps);

  const motionDir = getNamedSubrootDir(MOTION_CLAW_ID);
  const baseDir = path.dirname(motionDir);
  const audit = createSystemAudit(deps.fsFactory(baseDir), baseDir);
  const pm = createProcessManagerForCLI({ ...deps, baseDir });

  const watchdogPid = getWatchdogPid(deps.fsFactory);
  const watchdog = {
    pid: typeof watchdogPid === 'number' ? watchdogPid : undefined,
    alive: isWatchdogAlive(deps.fsFactory),
    entryPath: getWatchdogEntryPath(deps.fsFactory),
  };

  const daemonEntryPath = resolveDaemonEntry(deps.fsFactory(baseDir));

  const topology = createClawTopology({
    fs: deps.fsFactory(baseDir),
    chestnutRoot: baseDir,
    motionDir,
  });

  const view = await computeForumStatusView({
    fsFactory: deps.fsFactory,
    baseDir,
    clawTopology: topology,
    motionDir,
    pm,
    now: () => Date.now(),
    getStartTime: (pid: number) => getProcessStartTime(pid),
    watchdog,
    daemonEntryPath,
    audit,
  });

  const okCount = view.activeClaws.filter(c => c.status === 'ok').length;
  audit.write('status_forum', `claws=${okCount}`, `total=${view.totalClawCount}`);

  const errorClaws = view.activeClaws.filter((c): c is Extract<typeof c, { status: 'error' }> => c.status === 'error');
  if (errorClaws.length > 0) {
    const details = errorClaws.map(c => `${c.name}: ${c.error}`).join(', ');
    audit.write('status_forum_claw_errors', `count=${errorClaws.length}`, `details=${details}`);
  }
  if (view.orphans.error) {
    audit.write('status_forum_orphan_error', `error=${view.orphans.error}`);
  }

  for (const line of formatForumStatusView(view)) {
    console.log(line);
  }
}
