/**
 * @module L6.Assembly.Guidance
 * phase 9 立 / phase 203 ratify: NO_GUIDANCE by-design.
 *
 * 触发: CLI `chestnut contract create` → notifyClaw 投目标 claw inbox
 * 接收方: 目标 claw daemon (clawDir/INBOX_PENDING_DIR)
 * body 自足: 含 contract title + background + goal + expectations + subtasks 列表 + done 模板（claw 收到即开始执行）
 * 跨层 CLI hint 需要: ❌（详 design/modules/l6_assembly_composer_framework.md §2）
 *
 * 升档条件: contract create 路径 body 不再自含完整指令 / 需补外部调研 hint 时
 */

import { NO_GUIDANCE } from '../types.js';

export const composer = NO_GUIDANCE;
