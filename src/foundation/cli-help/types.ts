/**
 * @module L1.CliHelp.Types
 *
 * Phase 1477：CLI help 系统化（verb-fact 单源 + Assembly composer 拼装）。
 *
 * 本文件定义命令族 fact schema：每个 verb 一份 fact，描述命令的契约
 * （名字 / 分组 / 形态 / 摘要 / 参数 / 选项 / 示例）。
 *
 * 应然边界：
 * - foundation/ 层 = 不知 commander、不知 binary 字面、不知输出格式
 * - 仅持「what each verb does」的业务事实
 * - 装配选择（分组顺序 / 渲染格式 / binary 字面）归 Assembly composer
 *
 * 同型参考：foundation/.../motion-guidance.ts 的 StatusMotionGuidance facts
 * （phase 1469 β 基础设施立、phase 1472 γ1 motion 实施 / phase 1477 γ-help 镜像）。
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

/** retired verb 描述（仅出现在 footer，schema 未泛化、N=1 单实证）。 */
export interface RetiredVerbNote {
  retired: string;
  replacement: string;
  note?: string;
}
