/**
 * Sentinel PID guaranteed to exceed:
 *   - Linux pid_max default 4,194,304 (2^22)
 *   - macOS pid_max default 99,999
 *   - Windows typical < 100,000
 *
 * kernel: kill(DEAD_PID, 0) → ESRCH (no such process) or EINVAL (out of range)
 * Both errno → process treated as not alive in tests.
 *
 * Use DEAD_PID for number contexts (lockfile JSON / function args)
 * Use DEAD_PID_STRING for pidFile content (PID 文件存字符串)
 *
 * Replaces hardcoded 999999 / 99999999 / 999999999 magic across 9 sites
 * in 6 test files (phase 705 / r95 C fork).
 */
export const DEAD_PID = 999999999;
export const DEAD_PID_STRING = String(DEAD_PID);
