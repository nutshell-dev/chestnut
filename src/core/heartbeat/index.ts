/**
 * @module L5.Heartbeat (phase 1406)
 *
 * Motion 心跳触发器：周期性向 motion inbox 写入 'heartbeat' 消息。
 * 独立 L5 服务（从 L5 Runtime 拆出 / per phase 1406 design row
 * A.phase1406-runtime-to-claw-narrow-and-boundary-rework ⑤）。
 *
 * 业务语义独立：周期触发（timer）≠ 事件驱动循环（runtime）。
 */
export { Heartbeat, createHeartbeat } from './heartbeat.js';
export type { HeartbeatOptions } from './heartbeat.js';
export { HEARTBEAT_AUDIT_EVENTS } from './audit-events.js';
