import type { RootConfigAdmin, RootConfigReader } from '../../assembly/index.js';
import { MOTION_CLAW_ID, resolveClawDaemonDir } from '../../core/claw-topology/index.js';
import { getChestnutRoot, getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { readCurrentTurnSnapshot, STREAM_FILE } from '../../foundation/stream/index.js';
import {
  LAUNCHER_CAPABILITIES,
  type DaemonState,
  type LauncherActivityPayload,
  type LauncherDaemonPayload,
  type LauncherMessagePayload,
  type LauncherSnapshotPayload,
} from '../../cli-protocol/index.js';
import { LauncherActivityMapper, LauncherEventMapper } from '../launcher-envelope-producer.js';
import { assertPublishedClaw } from './claw-target.js';

export interface LauncherCommandDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'> & Pick<RootConfigAdmin, 'getInitializationState'>;
}

export function readLauncherDaemon(deps: LauncherCommandDeps, name: ClawId = MOTION_CLAW_ID): LauncherDaemonPayload {
  try {
    const pm = createProcessManagerForCLI({ ...deps, baseDir: getChestnutRoot() });
    const daemonDir = resolveClawDaemonDir(name);
    const liveness = pm.liveness(daemonDir);
    if (liveness.kind === 'alive') {
      const readiness = pm.readiness(daemonDir);
      return readiness.kind === 'ready'
        ? { state: 'running' }
        : { state: 'starting', detail: `daemon ${readiness.kind}` };
    }
    if (liveness.kind === 'absent' || liveness.kind === 'dead') return { state: 'stopped' };
    return { state: 'error', detail: `daemon ${liveness.kind}` };
  } catch (err) {
    // silent: liveness failures are returned in the structured daemon state.
    return { state: 'error', detail: formatErr(err) };
  }
}

export function daemonState(deps: LauncherCommandDeps): DaemonState {
  return readLauncherDaemon(deps).state;
}

export interface LauncherStreamSnapshot {
  payload: LauncherSnapshotPayload;
  tailOffset: number;
  clawDir: string;
  mapper: LauncherEventMapper;
  activityMapper: LauncherActivityMapper;
}

export function readLauncherSnapshot(deps: LauncherCommandDeps, name = MOTION_CLAW_ID): LauncherStreamSnapshot {
  const initialization = deps.rootConfig.getInitializationState();
  let current: ReturnType<typeof readCurrentTurnSnapshot> = { active: false, events: [], tailOffset: 0 };
  let clawDir = getNamedSubrootDir(MOTION_CLAW_ID);
  if (initialization === 'ready') {
    deps.rootConfig.loadGlobal();
    const target = assertPublishedClaw(deps, name);
    clawDir = target.clawDir;
    current = readCurrentTurnSnapshot(deps.fsFactory(clawDir), STREAM_FILE);
  }
  const mapper = new LauncherEventMapper();
  const activityMapper = new LauncherActivityMapper(name);
  const messages = new Map<string, LauncherMessagePayload>();
  let activity: LauncherActivityPayload | undefined;
  if (current.active) {
    for (const event of current.events) {
      for (const message of mapper.mapAll(event)) messages.set(message.messageId, message);
      const nextActivity = activityMapper.map(event);
      if (nextActivity) activity = nextActivity;
    }
  }
  return {
    payload: {
      workspace: { claw: name },
      initialization,
      daemon: readLauncherDaemon(deps),
      capabilities: LAUNCHER_CAPABILITIES,
      active: current.active,
      messages: [...messages.values()],
      ...(activity && activity.phase !== 'idle' ? { activity } : {}),
    },
    tailOffset: current.tailOffset,
    clawDir,
    mapper,
    activityMapper,
  };
}
