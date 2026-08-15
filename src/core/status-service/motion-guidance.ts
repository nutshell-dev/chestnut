/**
 * Motion guidance facts — phase 1472 Step D（phase 1439 convention γ1 实施）。
 *
 * 三层职责（phase 1439 立、详见 design/modules/l5_status_service.md §10 motion guidance
 * convention + l6_assembly.md §A motion-guidance-composer）：
 *
 * - **业主层（本文件）**：export motion 相关的状态查询 facts —— verb 片段 + 注释、
 *   **不含 CLI binary 字面**（`chestnut`）、**不含完整 invocation 字面**。业主只
 *   表达「motion 在 status 视角下应当知道哪些 CLI verb 关键字 + 各自语义」。这样
 *   M#5「底层模块不预设上层语义」满足：StatusService 不假设 binary 叫什么。
 *
 * - **composer 层（assembly/motion-guidance-composer.ts）**：物理拼装 `chestnut`
 *   binary 前缀 + facts.verb → 完整 invocation 字面。typed const Record 让编译期
 *   check 漂移（cli/index.ts 命令族重命名时 composer 输出会同步、不留 stale CLI 字面）。
 *
 * - **motion LLM 层**：从 status 工具尾段读 guidance 段、按 note 决策何时调 verb。
 */

export interface StatusMotionGuidanceFacts {
  /** verb 片段、不含 binary 字面、不含 `<args>` 占位拼装（占位由 composer 拼）。 */
  readonly verbs: readonly StatusMotionGuidanceVerb[];
  /** 顶层 note，解释这组 CLI hint 的 motion 使用场景。 */
  readonly note: string;
}

export interface StatusMotionGuidanceVerb {
  /** verb 关键字 + 必要 args 占位（subject-first 形态、由 composer 在前面拼 binary）。 */
  readonly fragment: string;
  /** 该 verb 的 motion 视角语义（单行简述、用户可读）。 */
  readonly purpose: string;
}

/**
 * Status 工具相关 verb facts —— 业主自己唯一懂的 motion 视角动作集。
 *
 * 字面只含 `<name>` 占位 + verb 关键字。binary `chestnut` 由 composer 加。
 */
export const STATUS_MOTION_GUIDANCE_FACTS: StatusMotionGuidanceFacts = {
  verbs: [
    {
      fragment: 'claw <name> status',
      purpose: '查看其他 claw 当前 contract / tasks / storage 业务态',
    },
    {
      fragment: 'claw list',
      purpose: '列出所有 claw 加 name + alive 状态、辅助选 <name>',
    },
  ],
  note: 'motion 用 status 工具查自己状态后，可通过下列 CLI 命令查其他 claw 的业务态（in-process status 工具仅观察自己）',
} as const;

/**
 * Composed guidance shape —— composer 输出 / status-tool 消费的形态。
 * 字面完整 invocation（含 binary）+ 单行 purpose。
 */
export interface StatusMotionGuidance {
  readonly commands: readonly { readonly invocation: string; readonly purpose: string }[];
  readonly note: string;
}

/**
 * Format guidance 段为 status 工具输出尾段字符串。
 * 与 status tool 行内 join 一致：headers + bulleted commands。
 */
export function formatMotionGuidance(g: StatusMotionGuidance): string {
  const lines: string[] = [];
  lines.push(''); // blank separator
  lines.push('[CLI hints for motion]');
  lines.push(g.note);
  for (const c of g.commands) {
    lines.push(`- ${c.invocation} — ${c.purpose}`);
  }
  return lines.join('\n');
}
