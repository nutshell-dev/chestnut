/**
 * @module L2a.ProcessManager.AuditSink
 *
 * ProcessManager 消费的最小审计能力（structural）：`write` + `message`。
 *
 * phase 1852 Step D：PM 各文件实际只调用 `audit.write(type, ...cols)`（55 处）与
 * `audit.message(s)`（17 处）；完整 AuditLog 表面（brand、preview/summary、
 * artifact/loss 生命周期、dispose）是 Audit owner 的责任，不得泄入跨模块边界。
 * `ProcessManagerAuditSink` 是消费方声明的结构接口 —— 非别名、非 Pick<>、无 brand ——
 * 真 AuditLog 结构满足，装配与测试零改动即可进入 PM 各入口。
 *
 * Write contract 保持 void（既有消费契约）：durability 与 fallback 处理留在
 * Audit owner 的 writer。越界使用（如 preview）在编译期暴露。
 */

export interface ProcessManagerAuditSink {
  write(event: string, ...details: (string | number)[]): void;
  message(s: string): string;
}
