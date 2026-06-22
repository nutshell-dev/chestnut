/**
 * @module L6.Watchdog.FailureClasses
 *
 * Type unions shared by watchdog (业主) + assembly guidance composers (consumer).
 *
 * Owner: watchdog defines the derive functions + body formatters (业务实现).
 * Foundation owns the type-only enum surface (assembly type-only import 不再反向 import watchdog).
 *
 * phase 552: extracted from watchdog/watchdog-utils to break assembly → watchdog reverse import.
 * Same pattern as phase 540 (formatClawStatusHint → foundation/utils).
 */

/**
 * Failure class for `claw_inactivity` watchdog notification.
 *
 * - `daemon_silent`: daemon alive but no events for inactiveMin → 提示主动 ping / 重发 prompt
 * - `daemon_errored`: daemon alive but encountered an error → motion 看 lastError 决定
 */
export type FailureClass = 'daemon_silent' | 'daemon_errored';

/**
 * Crash class for `crash_notification` watchdog notification.
 *
 * - `active_unexpected`: active contract + daemon dead + 无 clean-stop marker → 重启 daemon
 * - `active_user_stopped`: active contract + daemon dead + 有 clean-stop marker → motion 知情即可
 */
export type CrashClass = 'active_unexpected' | 'active_user_stopped';
