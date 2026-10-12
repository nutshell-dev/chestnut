/**
 * Phase 1935 Step C — 成功 Git 调用 stderr 诊断观察（snapshot 模块私有 helper）
 *
 * 成功（exit 0）的 Git 调用仍可能携带 stderr 诊断（如平台 warning）。诊断既不得
 * 污染协议解析（消费方只读 ExecResult.stdout），也不得被静默丢弃：两个 Snapshot
 * Git wrapper 统一经本 helper 观察一次。
 *
 * 边界：
 * - 审计介质失败时 fallback 到进程 stderr，保留原诊断与观察错误；
 * - fallback 自身也失败时按终端 best-effort 放弃——绝不因诊断通道故障抛出二次
 *   错误覆盖已完成的 Git 结果（不声称审计介质全失效时仍能持久化）。
 * - 事件只含 dir/stderr（经 audit.message 编码），不写 argv/stdin/env。
 */

import { formatErr } from '../node-utils/index.js';
import type { AuditLog } from '../audit/index.js';
import { emitSnapshotGitStderr } from './audit-emit.js';

export function observeGitStderr(audit: AuditLog, dir: string, stderr: string | undefined): void {
  if (!stderr) return;
  try {
    emitSnapshotGitStderr(audit, { dir, stderr: audit.message(stderr) });
  } catch (err) {
    try {
      process.stderr.write(
        JSON.stringify({ type: 'snapshot_git_stderr_audit_failed', dir, stderr, error: formatErr(err) }) + '\n',
      );
    } catch {
      // silent: 终端观察 best-effort 边界——fallback 写入也失败时无更多通道，
      // 但已完成 Git 操作的成功值不得被诊断通道故障覆盖。
    }
  }
}
