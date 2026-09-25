/**
 * Motion guidance composer — phase 1472 Step D（phase 1439 convention β 最小立 + γ1 实施）。
 *
 * 职责：把各业主 module 的 motion guidance facts（verb 片段 + purpose）
 * **物理拼**上 CLI binary 字面 `chestnut`，产出 motion-LLM 直接可读的
 * 完整 invocation 字面。
 *
 * 设计：
 * - binary 字面 `chestnut` 仅在本文件出现一次（编译期 typed const 防漂移）
 * - composer 当前只负责 StatusService；后续业主（如 ContractSystem motion notify
 *   verb / EvolutionSystem retrospective 触发 verb）按相同形态接入
 * - composer 输出形态稳定（StatusMotionGuidance）、不随业主增减新 verb 而变
 *
 * 应然边界：
 * - Assembly 是「motion-only composer 唯一允许拼 CLI 字面处」 —— 因为 Assembly
 *   是装配方、本身就需要知道部署形态（CLI binary 名 / 子命令族）；业主层不应该
 *   预设这些（phase 1909 起 binary 字面本身归 templates/messages 单源，本 composer
 *   仍是唯一拼装处）
 * - 非 motion claw 不调本 composer（assemble.ts 内 isMotion guard）
 */

import {
  STATUS_MOTION_GUIDANCE_FACTS,
  type StatusMotionGuidance,
} from '../core/status-service/index.js';
// phase 1909 Step C（M19）：CLI binary 字面归 templates/messages 单源；拼接仍在本 composer
import { MOTION_GUIDANCE_CLI_BINARY } from '../templates/messages/index.js';

/** CLI binary 字面 —— 经 templates/messages 单源消费（phase 1909 前为本文件内联 const）。 */
const CLI_BINARY = MOTION_GUIDANCE_CLI_BINARY;

/**
 * 拼 StatusService 的 motion guidance：binary + verb fragment → 完整 invocation。
 *
 * 返回 view 直接交给 status-tool execute 内尾段 append。
 */
export function composeStatusMotionGuidance(): StatusMotionGuidance {
  return {
    commands: STATUS_MOTION_GUIDANCE_FACTS.verbs.map((v) => ({
      invocation: `${CLI_BINARY} ${v.fragment}`,
      purpose: v.purpose,
    })),
    note: STATUS_MOTION_GUIDANCE_FACTS.note,
  };
}
