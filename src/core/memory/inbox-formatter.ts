/**
 * @module L4.MemorySystem
 * phase 1243: MemorySystem 自家 inbox 消息 rendering declarations。
 *
 * 业务语义全归 MemorySystem：
 *   - 'random_dream'  random-dream subagent 完成后向 motion 投递的 reflection
 *   - 'random_dream_completed' random-dream subagent 完成通知
 *   - 'deep_dream'    deep-dream subagent 完成后自投 inbox 的 reflection
 *
 * 当前均使用标准 system presentation（dreamOutput 已自含业务措辞）。
 */

import type { InboxMessageTypeDeclaration } from '../../foundation/messaging/index.js';

export const MEMORY_INBOX_MESSAGE_TYPES = [
  { owner: 'memory-system', type: 'random_dream', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'memory-system', type: 'random_dream_completed', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'memory-system', type: 'deep_dream', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
