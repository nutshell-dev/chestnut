export { createClawTopology } from './topology.js';
export { MOTION_CLAW_ID } from './motion-claw-id.js';
// phase 1864 Step B2（CT-D1 + CT-D5）：安装路径 API 群已撤出本 barrel——
// 稳定 owner = foundation/claw-identity（caller 直 import 该 owner、不经转发）。
export { routeNotifyClaw, routeNotifyClawAsync } from './claw-instance-paths.js';
export { resolveClawDaemonDir } from './daemon-dir.js';
// phase 765: notify_claw tool (moved from L2c Messaging)
export { createNotifyClawTool } from './tools/notify-claw.js';
export type {
  ClawTopology,
} from './types.js';
export {
  createCrossClawReadTool,
  createCrossClawLsTool,
  createCrossClawSearchTool,
} from './agent-tools.js';
export { decodeOutboxSummaryGuidance } from './jobs/outbox-summary/guidance-state.js';
export type { OutboxSummaryGuidanceState } from './jobs/outbox-summary/guidance-state.js';
export { createOutboxSummaryJob } from './jobs/outbox-summary/index.js';
