/**
 * @module L4.MemorySystem
 * phase 1419: MemorySystem 自家 2 dream inbox 消息 formatter（phase 1414
 * 落地完整化 sister）。
 *
 * 2 type 业务语义全归 MemorySystem：
 *   - 'random_dream'  random-dream subagent 完成后向 motion 投递的 reflection
 *   - 'deep_dream'    deep-dream subagent 完成后自投 inbox 的 reflection
 *
 * 当前 trivial passthrough（dreamOutput 已自含业务措辞）— 措辞业主自定。
 */

import type { MessageFormatter, MessageFormatterRegistry } from '../../foundation/messaging/index.js';

export const formatRandomDream: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatDeepDream: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export function registerMemoryFormatters(registry: MessageFormatterRegistry): void {
  registry.register('random_dream', formatRandomDream);
  registry.register('deep_dream', formatDeepDream);
}
