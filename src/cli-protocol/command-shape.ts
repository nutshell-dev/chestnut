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

/**
 * 投影 catalog spec 的 options 到 registrar（按 catalog 声明顺序）。
 * `runtimeLiteral` 项按 flag 查 `literalRegistrars` 就地注册（保 help 选项顺序与迁移前
 * 逐位一致）；未提供 registrar 的 literal 项跳过（注册顺序责任留在调用点）。
 */
export function applyCommandOptions<R extends CommandShapeRegistrar>(
  registrar: R,
  spec: CommandShapeSpec,
  literalRegistrars?: Readonly<Record<string, (registrar: R) => void>>,
): void {
  for (const opt of spec.options ?? []) {
    if (opt.runtimeLiteral) {
      literalRegistrars?.[opt.flag]?.(registrar);
      continue;
    }
    if (opt.required === true) registrar.requiredOption(opt.flag, opt.desc);
    else registrar.option(opt.flag, opt.desc);
  }
}

/** 通用形状投影：summary/options（含 literal 就地注册）到命令构建器。 */
export function shapeCommand<T extends { description(desc: string): unknown } & CommandShapeRegistrar>(
  cmd: T,
  spec: CommandShapeSpec,
  literalRegistrars?: Readonly<Record<string, (registrar: T) => void>>,
): T {
  cmd.description(spec.summary);
  applyCommandOptions(cmd, spec, literalRegistrars);
  return cmd;
}
