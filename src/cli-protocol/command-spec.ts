/**
 * @module L6.CLIProtocol.CommandSpec
 *
 * Phase 1253 Step B 立：CLIProtocol command spec schema。
 *
 * 本文件定义命令描述 schema：每个 command 一份 spec，描述命令的契约
 * （id / 分组 / 形态 / 摘要 / 参数 / 选项 / 示例）。
 *
 * 应然边界（Phase 1252 冻结）：
 * - CLIProtocol 是 L6 叶子协议模块、零实现依赖（不知 commander 实例、
 *   不知 handler、不知 Assembly runtime handle）
 * - 仅持「what each command does」的 CLI 命令业务事实
 * - handler / option parser / supervision policy 归 CLIProcess
 *
 * 历史：schema 源自 phase 1477 `src/cli/help/types.ts` VerbFact（phase 1479 从
 * foundation 挪 cli/help）；phase 1253 迁 CLIProtocol、字段 `name` 统一改 `id`，
 * 不再同时维护 name/verb 双 enum。
 */

/** command 形态：instance = 作用在指定 claw 上 (claw <name> <command>) / flat = 平面操作 (claw list / claw help)。 */
export type CommandForm = 'instance' | 'flat';

/** 分组：影响 help 渲染顺序，不影响业务语义。 */
export type CommandGroup = 'lifecycle' | 'messaging' | 'observation' | 'discovery';

export interface CommandArg {
  /** 占位名（例：`<message>` 显示时 renderer 自加尖括号 / `<path>`）。 */
  name: string;
  /** required = 显示尖括号 `<x>` / 非 required = 方括号 `[x]`。 */
  required: boolean;
  /** 一行说明，可省。 */
  desc?: string;
}

export interface CommandOption {
  /** 完整 flag 字面（例：`--limit <n>` / `--json` / `-t, --target <subdir>`）。 */
  flag: string;
  desc: string;
  /** 默认值字面（若有）。 */
  defaultValue?: string;
  /**
   * 必传 option（commander `.requiredOption`）。phase 1480 加：
   * 顶层 help 行的 signature 段会显示必传 option 的 flag 字面、
   * 避免「command 看起来无参、跑起来报 required option missing」silent-X
   * （phase 1480 trace spec 实证：顶层只出 `trace`、漏掉 `--contract <id>`）。
   */
  required?: boolean;
}

export interface ClawCommandSpec {
  /** command literal id（catalog 内唯一、router dispatch 与 help query 共用此 id）。 */
  id: string;
  group: CommandGroup;
  form: CommandForm;
  /** 一行摘要（顶层 help 列表显示）。 */
  summary: string;
  /** command 位置参数（顺序即出现顺序）。 */
  args?: readonly CommandArg[];
  /** command 选项。 */
  options?: readonly CommandOption[];
  /** 末尾示例（每行已含完整 `chestnut claw ...` 形态、renderer 直接出）。 */
  examples?: readonly string[];
  /** 退役 command / 别名说明等额外提示，仅在 per-command help 显示。 */
  note?: string;
}
