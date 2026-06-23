/**
 * git-gc-weekly cron job audit events（业主自治、归 helper）。
 * phase 180 拆 sub-event const、删 stem GIT_GC_WEEKLY（避 `step=enum` 跨业主漂）。
 */
export const GIT_GC_WEEKLY_AUDIT_EVENTS = {
  GIT_GC_WEEKLY_CLAW_FAILED: 'cron_git_gc_weekly_claw_failed',  // per-claw failure (拆 Q3=a)
  GIT_GC_WEEKLY_COMPLETED: 'cron_git_gc_weekly_completed',       // job lifecycle
} as const;

// 业主声明 per-event col schema (mirror phase 140 模式)
export const GIT_GC_WEEKLY_COLS = {
  [GIT_GC_WEEKLY_AUDIT_EVENTS.GIT_GC_WEEKLY_CLAW_FAILED]: [
    { name: 'claw', required: true },
    { name: 'error', required: true },
  ],
  [GIT_GC_WEEKLY_AUDIT_EVENTS.GIT_GC_WEEKLY_COMPLETED]: [
    { name: 'claws', required: true },  // 处理总数
  ],
} as const;
