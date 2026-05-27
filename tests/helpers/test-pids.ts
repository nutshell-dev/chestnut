/**
 * Fake live PID constants for test fixtures.
 *
 * These represent "alive but mock" process IDs used in tests that simulate
 * existing daemon processes (PID files, spawn returns, audit assertions).
 *
 * For "dead PID" semantics (process that doesn't exist / kill(0) returns ESRCH),
 * use `dead-pid.ts` instead (DEAD_PID = 999999999).
 *
 * Why two values: some tests (e.g. watchdog.test.ts) need two distinct fake PIDs
 * to verify multi-process logic (e.g. running daemon vs different running daemon).
 */
export const FAKE_LIVE_PID = 12345;
export const FAKE_LIVE_PID_STRING = String(FAKE_LIVE_PID);

export const FAKE_LIVE_PID_ALT = 99999;
export const FAKE_LIVE_PID_ALT_STRING = String(FAKE_LIVE_PID_ALT);

/** CAS (compare-and-swap) test scenario fake PID — distinct from FAKE_LIVE_PID / _ALT. */
export const FAKE_LIVE_PID_CAS = 11111;
export const FAKE_LIVE_PID_CAS_STRING = String(FAKE_LIVE_PID_CAS);
