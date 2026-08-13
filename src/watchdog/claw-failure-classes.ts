/**
 * @module L6.Watchdog
 *
 * Type unions shared by watchdog (业主) + assembly guidance composers (consumer).
 *
 * Owner: watchdog defines the derive functions + body formatters (业务实现).
 * Foundation owns the type-only enum surface (assembly type-only import 不再反向 import watchdog).
 *
 * phase 552: extracted from watchdog/watchdog-utils to break assembly → watchdog reverse import.
 * Same pattern as phase 540 (formatClawStatusHint → cli/utils).
 *
 * phase 1383 (P2b): FailureClass (daemon_silent/daemon_errored) 退场——
 * claw_inactivity 通知/subscription 移除、停滞自活归 daemon 内化。仅留 CrashClass。
 */

/**
 * Crash class for `claw_crashed` watchdog notification.
 *
 * - `active_unexpected`: active contract + daemon dead + 无 clean-stop marker → 重启 daemon
 * - `active_user_stopped`: active contract + daemon dead + 有 clean-stop marker (user/system 主动 stop) → motion 知情即可
 */
export type CrashClass = 'active_unexpected' | 'active_user_stopped';
