/**
 * @module L5.Cron.GitHygieneMonitor
 * @layer L5
 * @depends L1.FileSystem, L1.ProcessExec, L2.AuditLog, L2.Messaging
 *
 * Cron job: 周期采样 git state (worktree / branch / stash / .claude/worktrees/) + 超阈值 emit audit + motion notify。
 *
 * phase 1204 derive (F.3 anchor B.phase1201-git-hygiene-cron-N2-evidence 物理实施兑现、phase 1181 + 1201 anchor 链闭环)。
 */

import { exec } from '../../../foundation/process-exec/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { InboxWriter } from '../../../foundation/messaging/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const GIT_HYGIENE_MONITOR_CRON_TIMEOUT_MS = 60_000;

// 阈值默认值 (derive from phase 1181 + 1201 实证 baseline + buffer、user 可 config override)
const DEFAULT_WORKTREE_THRESHOLD = 50;
const DEFAULT_BRANCH_THRESHOLD = 100;
const DEFAULT_STASH_THRESHOLD = 10;
const DEFAULT_CLAUDE_WORKTREES_THRESHOLD = 0; // 任何登记 alert (F.4 实证)

export interface GitHygieneMonitorOptions {
  clawforumDir: string;       // 项目根（含 .git）
  audit: AuditLog;
  motionInbox?: InboxWriter;
  worktreeThreshold?: number;
  branchThreshold?: number;
  stashThreshold?: number;
  claudeWorktreesThreshold?: number;
}

export async function runGitHygieneMonitor(opts: GitHygieneMonitorOptions): Promise<void> {
  const {
    clawforumDir,
    audit,
    motionInbox,
    worktreeThreshold = DEFAULT_WORKTREE_THRESHOLD,
    branchThreshold = DEFAULT_BRANCH_THRESHOLD,
    stashThreshold = DEFAULT_STASH_THRESHOLD,
    claudeWorktreesThreshold = DEFAULT_CLAUDE_WORKTREES_THRESHOLD,
  } = opts;

  // 采样 git state
  let worktreeCount = 0;
  let branchCount = 0;
  let stashCount = 0;
  let claudeWorktreesCount = 0;

  try {
    const wtOutput = await exec('git', ['worktree', 'list'], { cwd: clawforumDir });
    worktreeCount = wtOutput.output.split('\n').filter(l => l.trim()).length;
    claudeWorktreesCount = wtOutput.output.split('\n').filter(l => l.includes('.claude/worktrees/')).length;
  } catch (err) {
    // partial scan / best-effort + audit emit ENOENT 分流见 audit-size-monitor pattern
  }

  try {
    const brOutput = await exec('git', ['branch', '-a'], { cwd: clawforumDir });
    branchCount = brOutput.output.split('\n').filter(l => l.trim()).length;
  } catch (err) { /* silent: best-effort partial scan */ }

  try {
    const stOutput = await exec('git', ['stash', 'list'], { cwd: clawforumDir });
    stashCount = stOutput.output.split('\n').filter(l => l.trim()).length;
  } catch (err) { /* silent: best-effort partial scan */ }

  // emit base snapshot
  audit.write(
    CRON_AUDIT_EVENTS.GIT_HYGIENE_SNAPSHOT,
    `worktree=${worktreeCount}`,
    `branch=${branchCount}`,
    `stash=${stashCount}`,
    `claude_worktrees=${claudeWorktreesCount}`,
  );

  // 阈值检测 + 独立 emit + motion notify
  if (worktreeCount > worktreeThreshold) {
    audit.write(CRON_AUDIT_EVENTS.GIT_HYGIENE_WORKTREE_THRESHOLD, `count=${worktreeCount}`, `threshold=${worktreeThreshold}`);
    motionInbox?.writeSync({ type: 'cron_git_hygiene', source: 'cron', priority: 'normal', body: `git worktree count ${worktreeCount} > ${worktreeThreshold}`, idPrefix: `${Date.now()}_git_hygiene_worktree` });
  }
  if (branchCount > branchThreshold) {
    audit.write(CRON_AUDIT_EVENTS.GIT_HYGIENE_BRANCH_THRESHOLD, `count=${branchCount}`, `threshold=${branchThreshold}`);
    motionInbox?.writeSync({ type: 'cron_git_hygiene', source: 'cron', priority: 'normal', body: `git branch count ${branchCount} > ${branchThreshold}`, idPrefix: `${Date.now()}_git_hygiene_branch` });
  }
  if (stashCount > stashThreshold) {
    audit.write(CRON_AUDIT_EVENTS.GIT_HYGIENE_STASH_THRESHOLD, `count=${stashCount}`, `threshold=${stashThreshold}`);
    motionInbox?.writeSync({ type: 'cron_git_hygiene', source: 'cron', priority: 'normal', body: `git stash count ${stashCount} > ${stashThreshold}`, idPrefix: `${Date.now()}_git_hygiene_stash` });
  }
  if (claudeWorktreesCount > claudeWorktreesThreshold) {
    audit.write(CRON_AUDIT_EVENTS.GIT_HYGIENE_CLAUDE_WORKTREES, `count=${claudeWorktreesCount}`);
    motionInbox?.writeSync({ type: 'cron_git_hygiene', source: 'cron', priority: 'normal', body: `.claude/worktrees/ count ${claudeWorktreesCount} > ${claudeWorktreesThreshold}`, idPrefix: `${Date.now()}_git_hygiene_claude_worktrees` });
  }
}
