/**
 * @module L6.Assembly.Guidance
 * phase 7 γ7: real composer for `task_queue_overflow`.
 * phase 208: signature 收窄 GuidanceEntry | null → GuidanceEntry
 *   (body 无条件 return { text }、type 收窄 hygiene)
 *
 * task_queue_overflow = system-level overload (1000 pending tasks accumulated).
 * 超出 motion 决策能力 — motion 是 user 通道、不该自家 retry / 不该等 / 应立即升级。
 * Chain: system → motion → user → developer.
 *
 * No CLI action for motion (system internal queue / no inspection or cancel verb).
 * Composer 教 motion immediately escalate to user.
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { taskQueueOverflowGuidanceText } from '../../../templates/messages/index.js';

interface TaskQueueOverflowState {
  cap?: string;
  queue_length?: string;
}

export const composer: GuidanceComposer<TaskQueueOverflowState> = (): GuidanceEntry => {
  return {
    text: taskQueueOverflowGuidanceText(),
  };
};
