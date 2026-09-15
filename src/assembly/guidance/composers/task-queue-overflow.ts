/**
 * @module L6.Assembly.Guidance
 * phase 1836: composer for `task_queue_overflow` — NO_GUIDANCE sentinel。
 *
 * 事件正文已自含事实（被拒任务、拒绝处置前观测的队列数量/上限、系统已执行处置），
 * 不附无依据的故障推断或自动行动指令；旧升级用户/停派 guidance 已退役。
 * 注册保留（显式表态无 guidance），不是缺注册碰巧为空。
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
