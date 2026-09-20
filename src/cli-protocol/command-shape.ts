/**
 * @module L6.CLIProtocol.CommandShape
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: 命令形状 catalog 投影通用面。
 *
 * 形态源自 phase 1798 的 `applyClawCommandOptions`（claw 族专有 helper 保持不动）：
 * catalog 声明 entry（summary/options）→ 投影到 commander 注册点；help/parser 同源。
 *
 * 边界（与 1798 一致）：
 * - `defaultValue` 是展示字面、不投影为 commander default；
 * - 带**真实运行时 default / 函数式 parser** 的 option 不投影（`runtimeLiteral: true`），
 *   在注册点保留字面 — parity 测试守「注册点裸字面 ⊆ catalog」方向。
 */

export interface CommandOptionShape {
  /** 完整 flag 字面（如 `--limit <n>`）。 */
  flag: string;
  desc: string;
  required?: boolean;
  /** help 展示默认值字面（不投影为 commander default）。 */
  defaultValue?: string;
  /** 注册点保留字面（运行时 default / fn parser）——投影时跳过。 */
  runtimeLiteral?: true;
}

export interface CommandShapeSpec {
  id: string;
  summary: string;
  options?: CommandOptionShape[];
}

/** commander Command 的形状注册面（仅本投影用到的两个方法）。 */
export interface CommandShapeRegistrar {
  option(flag: string, desc: string): unknown;
  requiredOption(flag: string, desc: string): unknown;
}

/** 投影 catalog spec 的可投影 options 到 registrar（runtimeLiteral 项跳过）。 */
export function applyCommandOptions(registrar: CommandShapeRegistrar, spec: CommandShapeSpec): void {
  for (const opt of spec.options ?? []) {
    if (opt.runtimeLiteral) continue;
    if (opt.required === true) registrar.requiredOption(opt.flag, opt.desc);
    else registrar.option(opt.flag, opt.desc);
  }
}
