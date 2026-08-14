/**
 * @module L6.Assembly.Guidance
 * phase 1391 Step B: NO_GUIDANCE by-design.
 *
 * 触发: AsyncTaskSystem stall-detector 检测到 SubAgentTask 任务级等待态停滞
 * 接收方: 父 claw（task.parentClawId）
 * body 自足: 含 taskId / fullTaskId / stage=stalled / idle_ms / runtime_ms JSON
 * 跨层 CLI hint 需要: ❌（父 claw 按既有 task_result 链路处置；阶段消息仅通知）
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
