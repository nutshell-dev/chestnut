/**
 * @module L6.Assembly.Guidance
 * phase 1386: composer for inbox type `wakeup` — NO_GUIDANCE sentinel.
 *
 * 定时消息正文直接交 claw agent 处理（agent 读正文即知为何被叫醒），不生成 motion 决策 affordance。
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
