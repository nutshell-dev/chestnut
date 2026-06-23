/**
 * Test helper: 算 daemonDir branded path for PM tests after phase 694。
 * PM API take DaemonDir 而非 ClawId、test 需要 brand string path 传入。
 */
import * as path from 'path';
import { makeDaemonDir, type DaemonDir } from '../../src/foundation/process-manager/index.js';

/**
 * 算 daemonDir for a test claw under tempDir/claws/<clawId>/.
 * 与 prod resolveClawDaemonDir 形态一致（仅不走 motion 特例）。
 */
export function testClawDaemonDir(tempDir: string, clawId: string): DaemonDir {
  return makeDaemonDir(path.join(tempDir, 'claws', clawId));
}

/**
 * 算 motion daemonDir for tests using tempDir/motion/。
 */
export function testMotionDaemonDir(tempDir: string): DaemonDir {
  return makeDaemonDir(path.join(tempDir, 'motion'));
}
