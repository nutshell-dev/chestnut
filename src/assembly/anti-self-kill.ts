/**
 * Anti-self-kill guard for motion-chain exec tool.
 * Moved from L2c command-tool/exec.ts (M#5 — phase 758).
 */

import type { PreExecGuard } from '../foundation/command-tool/exec.js';

function looksLikeChestnutSelfKill(command: string): boolean {
  return /\bchestnut\s+(motion\s+)?stop\b/i.test(command);
}

export function createAntiSelfKillGuard(): PreExecGuard {
  return (command: string) => {
    if (looksLikeChestnutSelfKill(command)) {
      return {
        allow: false,
        reason:
          'Error: motion-chain cannot exec `chestnut stop` / `chestnut motion stop` ' +
          'via shell. The command SIGTERMs motion itself; the in-flight tool result ' +
          'is lost. To stop motion, ask the user or use an external CLI process.',
      };
    }
    return { allow: true };
  };
}
