/**
 * AuditLog module (L2)
 *
 * 状态迁移审计记录。纯追加写。
 * 服务于"运行中产生的所有信息全量记录以供审计"。
 *
 * Resources: audit.tsv
 * Dependencies: FileSystem
 * Coupling: none
 * Consumers: Daemon, Runtime, ContractSystem, SubagentSystem
 *
 * 容错：写失败不抛异常（不中断业务），但通过 console.warn 暴露失败信息。
 */

export interface IAuditSink {
  write(type: string, ...cols: (string | number)[]): void;
}

export { AuditWriter } from './writer.js';
