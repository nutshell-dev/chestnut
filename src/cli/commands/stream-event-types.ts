/**
 * @module L6.CLI.StreamEventTypes
 * CLI 汇总：stream.jsonl 全量事件判别联合（phase 1321 分层拆件）。
 *
 * stream 的 StreamEvent 已诚实化为协议基础（ts + type、payload unknown）；
 * 消费端（CLI）可 import 一切 → 全量 56 判别联合在此汇总：
 *   - 协议层 46：stream 的 STREAM_EVENT_NAMES + StreamEventMap（payload 单源在 stream）
 *   - 上层 10：agent turn 6（phase 1789 起经本地稳定 wire catalog、不导入业务 owner）
 *     / async-task-system 3 / assembly 1（payload 本地定义）
 */

import { STREAM_EVENT_NAMES, type StreamEventMap } from '../../foundation/stream/index.js';
import { STREAM_TASK_EVENTS } from '../../core/async-task-system/index.js';
import { ASSEMBLY_STREAM_EVENTS } from '../../assembly/index.js';

/**
 * phase 1789: 稳定 wire catalog——agent turn 生命周期 6 事件的字符串映射。
 * CLI 不导入业务 owner（subagent SUBAGENT_EVENTS）；与 owner 的值一致性由
 * tests/cli/stream-event-types.test.ts parity 断言守护。
 */
export const STREAM_WIRE_EVENTS = [
  'turn_start',
  'llm_start',
  'tool_result',
  'turn_end',
  'turn_interrupted',
  'turn_error',
] as const;

export type StreamWireEvent = (typeof STREAM_WIRE_EVENTS)[number];

/** 全量 type 值联合（协议层 46 + 上层 10 = 56） */
export type CliStreamEventType =
  | (typeof STREAM_EVENT_NAMES)[keyof typeof STREAM_EVENT_NAMES]
  | StreamWireEvent
  | (typeof STREAM_TASK_EVENTS)[keyof typeof STREAM_TASK_EVENTS]
  | (typeof ASSEMBLY_STREAM_EVENTS)[keyof typeof ASSEMBLY_STREAM_EVENTS];

/**
 * 上层 10 事件 payload（本地定义；协议层 46 引用 stream 的 StreamEventMap——含 system_notify
 * 与 send_content_*）。空成员用 `{ trace_id?: string }` 而非 Record<string, never>——
 * stream-callbacks checkWrite 会注入 trace_id（1316 Step B 教训）。
 */
type UpperPayloadMap = {
  turn_start: { sources?: Array<{ text: string; type: string }>; trace_id?: string };
  llm_start: { trace_id?: string };
  tool_result: { name: string; tool_use_id: string; success: boolean; summary: string; step: number; maxSteps: number; trace_id?: string };
  turn_end: { trace_id?: string };
  turn_interrupted: { cause: string; message?: string; trace_id?: string };
  turn_error: { error: string; trace_id?: string };
  task_started: { taskId: string; taskKind: string; silent: boolean; fullTaskId?: string; command?: string; startedAt?: number; trace_id?: string };
  task_attempt_start: { taskId: string; trace_id?: string };
  task_completed: { taskId: string; trace_id?: string };
  daemon_started: { clawId: string; pid: number; trace_id?: string };
};

/** 全量 payload 判别联合（1316 StreamEventMap 全量形态迁移至消费端汇总） */
export type CliStreamEvent = {
  [K in CliStreamEventType]: { type: K; ts: number } & (K extends keyof StreamEventMap
    ? StreamEventMap[K]
    : K extends keyof UpperPayloadMap
      ? UpperPayloadMap[K]
      : {});
}[CliStreamEventType];
