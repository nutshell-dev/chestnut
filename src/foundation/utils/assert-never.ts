/**
 * @module L2.Utils.AssertNever
 * phase 200: M#9 exhaustive switch 编译期 narrow 工具单源。
 *
 * 用法（switch exhaustive default）:
 *
 *   switch (x) {
 *     case 'a': ...; break;
 *     case 'b': ...; break;
 *     default: return assertNever(x);  // or: assertNever(x);
 *   }
 *
 * 类型语义：参数 `x: never` 让 TS 编译期 narrow — switch case 全列时
 * default 分支不可达、x 类型已 narrow 到 never、传入合法；若 switch
 * 漏 case、x 类型不再是 never、报 TS2345 编译错。
 *
 * 运行时语义：理论 unreachable、若因 type 系统逃逸（`as` 转换 / runtime
 * 来源等）实际执行、throw `Unhandled variant: ${JSON.stringify(x)}` 含
 * runtime value、stack trace 含 caller 定位。
 *
 * 历史：phase 196 立 inbox 状态空间编入此 pattern、phase 199 推广 12 file
 * 含 inline 同 helper；phase 200 抽共享单源、12 file 统一 import。
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
