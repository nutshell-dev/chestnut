/**
 * phase 1872 Step C: 装配期构造回滚注册表（assembly-partial-construction-rollback 收口）。
 *
 * 未提交装配按构造序登记已构造资源；装配失败时**反序** best-effort teardown
 * （最后构造的先释放）。次生失败经 reporter 留证——不静默、不遮蔽原 error
 * （原 error 由调用方 rethrow，cause 链不丢）。
 *
 * 成功路径不调用 run()（零漂移；正常 teardown 走 disassemble）。
 */
import { formatErr } from '../foundation/node-utils/index.js';

export interface AssemblyRollback {
  /**
   * 登记一个已构造资源的 teardown（构造序调用；run 时反序执行）。
   * 返回值可以是 owner 的 typed outcome（如 close/stop 的结果）——rollback 为
   * best-effort teardown，不在此重判 outcome 语义（归 owner/disassemble 面）；
   * 仅 throw/reject 计次生失败。
   */
  register(name: string, dispose: () => unknown | Promise<unknown>): void;
  /** 反序执行全部登记 teardown；次生失败报给 reporter（reporter 自身失败降级 stderr）。 */
  run(): Promise<void>;
}

/** reporter = 次生失败的留证通道（实施侧通常为 audit，早期失败降级 stderr）。 */
export function createAssemblyRollback(
  reportSecondaryFailure: (step: string, error: unknown) => void,
): AssemblyRollback {
  const entries: Array<{ name: string; dispose: () => unknown | Promise<unknown> }> = [];
  return {
    register(name, dispose) {
      entries.push({ name, dispose });
    },
    async run() {
      for (const entry of [...entries].reverse()) {
        try {
          await entry.dispose();
        } catch (error) {
          try {
            reportSecondaryFailure(entry.name, error);
          } catch {
            // silent: 留证通道自身失败 → stderr 最后兜底（次生失败信息不丢）。
            process.stderr.write(
              `[assembly] rollback teardown failed step=${entry.name}: ${formatErr(error)}\n`,
            );
          }
        }
      }
    },
  };
}
