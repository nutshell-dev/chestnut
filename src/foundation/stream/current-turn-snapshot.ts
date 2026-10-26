/**
 * @module L2b.Stream.CurrentTurnSnapshot
 *
 * current-turn 启动快照（phase 2003）：launcher 重开时只恢复"启动瞬间仍活跃"的 turn，
 * 已结束 turn 不重放。
 *
 * 职责边界（分层）：本模块只做文件扫描/完整行解析/终止判定/字节边界计算，
 * 返回该 turn 的原始事件；message/activity 压缩（累计快照语义）归调用方
 * （claw-stream 经 LauncherEventMapper/LauncherActivityMapper，L6 依赖方向不被反转）。
 *
 * 边界语义：tailOffset = 最后一个完整行（\n 结尾）之后的文件字节数；
 * 末尾残缺行不进快照、不计入边界（reader 从 tailOffset 启动后会重读该行完整版本）。
 */

import type { FileSystem } from '../fs/index.js';
import { parseStreamLines } from './parse-stream-lines.js';
import { findRecentTurnStartOffset } from './turn-start-offset.js';
import type { StreamEvent } from './types.js';

/** turn 终止事件集合（subagent 语义 owner：viewport/stream-event-types.ts）。 */
const TURN_TERMINAL_TYPES = new Set(['turn_end', 'turn_error', 'turn_interrupted']);

export interface CurrentTurnSnapshot {
  /** 最近 turn 是否仍活跃（未遇到终止事件）。 */
  active: boolean;
  /** 活跃 turn 自 turn_start 起的原始事件（active=false 时为空）。 */
  events: StreamEvent[];
  /** 快照读取结束时的完整 JSONL 字节边界；reader 应从该 offset 启动。 */
  tailOffset: number;
}

/**
 * 读取最近 turn 的快照事实。
 *
 * 判定：从最近 turn_start 行（findRecentTurnStartOffset，64KB 反向窗口、CJK 字节安全）
 * 读到文件尾；只解析完整行。若其中出现 turn_end/turn_error/turn_interrupted 则 turn 已结束
 * （active=false、events 为空）；否则 active=true 且 events 为该 turn 全部完整事件。
 * turn_start 未找到 / 文件不存在 / 空文件 → active=false，tailOffset=文件 size（或 0）。
 */
export function readCurrentTurnSnapshot(fs: FileSystem, streamPath: string): CurrentTurnSnapshot {
  if (!fs.existsSync(streamPath)) return { active: false, events: [], tailOffset: 0 };
  const size = fs.statSync(streamPath).size;
  if (size === 0) return { active: false, events: [], tailOffset: 0 };
  const start = findRecentTurnStartOffset(fs, streamPath);
  if (start >= size) return { active: false, events: [], tailOffset: size };
  const text = fs.readBytesSync(streamPath, start, size).toString('utf-8');
  const { events, leftover } = parseStreamLines(text, '');
  const tailOffset = size - Buffer.byteLength(leftover, 'utf-8');
  if (events.some((e) => TURN_TERMINAL_TYPES.has(e.type as string))) {
    return { active: false, events: [], tailOffset };
  }
  return { active: true, events: events as unknown as StreamEvent[], tailOffset };
}
