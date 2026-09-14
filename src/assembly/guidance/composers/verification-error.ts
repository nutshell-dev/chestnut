/**
 * @module L6.Assembly.Guidance
 * phase 1469 立 / phase 203 ratify: NO_GUIDANCE by-design.
 *
 * 触发: claw submit_subtask → verifier 执行 throw（programming_bug / subagent_timeout）
 * 接收方: 调用方 claw 自己
 * body 自足: 含原异常与已提交处置；系统按阈值退回待提交或放行
 * （handleVerificationErrorRetry 返回真实 disposition），不自动重新验收（phase 1829 更正：
 * 旧注释「系统自动 retry」不实——退回 todo 是等待重新提交，不是系统再次验收）
 * 跨层 CLI hint 需要: ❌（详 design/modules/l6_assembly_composer_framework.md §2）
 *
 * 升档条件: error 类需 claw 主动调研 / restart 类 CLI hint 时
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
