/**
 * @module L6.Assembly.Guidance
 * phase 1469 立 / phase 203 ratify: NO_GUIDANCE by-design.
 *
 * 触发: daemon 启动检查后投递（daemon-loop.ts createStartupCheckDelivery；
 *       投递可能重试、到达可能延迟）
 * 接收方: 本 claw 智能体
 * body 自足: 说明启动检查时发现仍有活跃契约、指导结合当前状态继续未完成工作
 * 跨层 CLI hint 需要: ❌（详 design/modules/l6_assembly_composer_framework.md §2）
 *
 * 升档条件: 启动检查失败 + 需要 claw 调用 restart / inspect 类 CLI hint 时（如 daemon recovery 类）
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
