/**
 * @module L6.Cli.Help.Types
 *
 * Phase 1477 立 / phase 1479 layering fix（从 L1 foundation 挪到 L6 cli）。
 *
 * 本文件定义命令族 fact schema：每个 verb 一份 fact，描述命令的契约
 * （名字 / 分组 / 形态 / 摘要 / 参数 / 选项 / 示例）。
 *
 * 应然边界：
 * - L6 cli 业主自家 schema、不知 commander 实例、不知 binary 字面、不知输出格式
 * - 仅持「what each verb does」的 CLI 命令业务事实
 * - 装配选择（分组顺序 / 渲染格式 / binary 字面）归 Assembly composer
 *
 * 同型参考：core/status-service/motion-guidance.ts StatusMotionGuidance facts
 * （phase 1469 立、归业主 L5 core、phase 1472 γ1 motion 实施 / 本 fact 同型归 L6 cli 业主）。
 *
 * 注：phase 1477 初立时错放 `src/foundation/cli-help/`、违 ML#5 底层不预设上层；
 * phase 1479 修：foundation L1 不知 CLI verb / args 这些 L6 概念，挪 `src/cli/help/`。
 */

/** verb 形态：instance = 作用在指定 claw 上 (claw <name> <verb>) / flat = 平面操作 (claw list / claw help)。 */
export type VerbForm = 'instance' | 'flat';

/** 分组：影响 composer 渲染顺序，不影响业务语义。 */
export type VerbGroup = 'lifecycle' | 'messaging' | 'observation' | 'discovery';

export interface VerbArg {
  /** 占位名（例：`<message>` 显示时 composer 自加尖括号 / `<path>`）。 */
  name: string;
  /** required = 显示尖括号 `<x>` / 非 required = 方括号 `[x]`。 */
  required: boolean;
  /** 一行说明，可省。 */
  desc?: string;
}

export interface VerbOption {
  /** 完整 flag 字面（例：`--limit <n>` / `--json` / `-t, --target <subdir>`）。 */
  flag: string;
  desc: string;
  /** 默认值字面（若有）。 */
  defaultValue?: string;
  /**
   * 必传 option（commander `.requiredOption`）。phase 1480 加：
   * 顶层 help 行的 signature 段会显示必传 option 的 flag 字面、
   * 避免「verb 看起来无参、跑起来报 required option missing」silent-X
   * （phase 1480 trace fact 实证：顶层只出 `trace`、漏掉 `--contract <id>`）。
   */
  required?: boolean;
}

export interface VerbFact {
  /** verb 名（router VERB_NAMES 与本字段一一对应、由 invariant 守）。 */
  name: string;
  group: VerbGroup;
  form: VerbForm;
  /** 一行摘要（顶层 help 列表显示）。 */
  summary: string;
  /** verb 位置参数（顺序即出现顺序）。 */
  args?: readonly VerbArg[];
  /** verb 选项。 */
  options?: readonly VerbOption[];
  /** 末尾示例（每行已含完整 `clawforum claw ...` 形态、composer 直接出）。 */
  examples?: readonly string[];
  /** 退役 verb / 别名说明等额外提示，仅在 per-verb help 显示。 */
  note?: string;
}
