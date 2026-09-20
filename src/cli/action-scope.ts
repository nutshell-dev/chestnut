/**
 * @module L6.CLI.ActionScope
 * phase 1874 Step I（cli-audit-lifecycle-fragmented）: CLI action 级 resource scope。
 *
 * 背景：一次 CLI invoke 创建的 AuditLog 句柄散布在入口与各 handler
 * （`createDirContext` / `createSystemAudit` 数十处）、成功与显式 exit 路径无一致
 * dispose——audit fallback/buffer 生命周期不完整、短进程依赖 OS 退出兜底。
 *
 * 语义：
 * - 一次 CLI invoke = 一个 scope（CLIProcess 每次 invoke 独立进程模型，故 scope
 *   以模块级 current 持有；非 wrapper 直调（测试/内部）无 scope 时回落裸创建）。
 * - `auditFor(dir)`：同 dir 复用同一 AuditLog、创建即注册 dispose。
 * - `disposeAll(reason)`：幂等、注册反序、逐个 best-effort；失败写 stderr 留证
 *   （不 throw——dispose 失败不改变 action 结果）。
 */
import { createDirContext, type AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';

export interface CliActionScope {
  /** 本 action 的 dir 级 audit（同 dir 复用；创建即注册 dispose）。 */
  auditFor(dir: string): AuditLog;
  /** 注册额外资源 dispose（反序执行）。 */
  register(name: string, dispose: () => Promise<void> | void): void;
  /** 幂等：所有注册资源反序 best-effort dispose；失败留证不抛。 */
  disposeAll(reason: string): Promise<void>;
}

interface ScopeEntry {
  name: string;
  dispose: () => Promise<void> | void;
}

export function createCliActionScope(deps: { fsFactory: (baseDir: string) => FileSystem }): CliActionScope {
  const audits = new Map<string, AuditLog>();
  const entries: ScopeEntry[] = [];
  let disposed = false;

  const auditFor = (dir: string): AuditLog => {
    const existing = audits.get(dir);
    if (existing) return existing;
    const { audit } = createDirContext({ fsFactory: deps.fsFactory }, dir);
    audits.set(dir, audit);
    register(`audit:${dir}`, () => audit.dispose?.());
    return audit;
  };

  const register = (name: string, dispose: () => Promise<void> | void): void => {
    if (disposed) {
      // scope 已终态：立即释放、不留悬挂资源（fail-loud 于 stderr）
      try {
        void dispose();
      } catch (err) {
        console.error(`[cli] late dispose failed (${name}): ${String(err)}`);
      }
      return;
    }
    entries.push({ name, dispose });
  };

  const disposeAll = async (reason: string): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const entry of [...entries].reverse()) {
      try {
        await entry.dispose();
      } catch (err) {
        // dispose 失败不阻断退出但留证（DP-2 不静默吞）
        console.error(`[cli] action scope dispose failed (${entry.name}, reason=${reason}): ${String(err)}`);
      }
    }
    entries.length = 0;
    audits.clear();
  };

  return { auditFor, register, disposeAll };
}

/**
 * 当前 action 的 scope（CLIProcess 每次 invoke = 独立进程 → 模块级 current 语义充分）。
 * 非 wrapper 直调（测试 / 内部 helper）无 scope 时回落裸创建。
 */
let currentScope: CliActionScope | null = null;

/** wrapper 终态边界使用：设置/清除当前 scope。 */
export function setCurrentActionScope(scope: CliActionScope | null): void {
  currentScope = scope;
}

/**
 * handler 侧取本 action 的 dir audit：
 * - 有 scope（wrapper 调用路径）→ scope.auditFor(dir)（复用 + 由 scope 统一 dispose）
 * - 无 scope（测试/直调）→ 裸 createDirContext（保持原语义）
 */
export function actionAuditFor(dir: string, deps: { fsFactory: (baseDir: string) => FileSystem }): AuditLog {
  if (currentScope) return currentScope.auditFor(dir);
  return createDirContext({ fsFactory: deps.fsFactory }, dir).audit;
}

/** 注册额外资源到当前 scope（无 scope 时立即 best-effort 释放由 caller 负责，返回 false）。 */
export function registerActionResource(name: string, dispose: () => Promise<void> | void): boolean {
  if (!currentScope) return false;
  currentScope.register(name, dispose);
  return true;
}
