/**
 * @module L6.CLI.MotionCliGuard
 *
 * CommandTool injects CHESTNUT_CALLER_AGENT_ID for agent exec. The sole CLI
 * entry captures that marker before argv parsing and immediately deletes it,
 * so child daemon/watchdog processes cannot inherit caller identity. The
 * captured value is converted to a caller-scoped typed capability; no later
 * authorization decision reads process.env.
 */

import type { Command } from 'commander';
import { CALLER_AGENT_ID_ENV } from '../foundation/command-tool/index.js';
import {
  createCapturedCliMotionAccess,
  MotionAccessDeniedError,
  requireMotionAccess,
  type MotionAccessCapability,
  type MotionOperation,
} from '../core/claw-topology/index.js';
import { CliError } from './errors.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';
import { classifyMotionCliCommand } from './motion-cli-command-registry.js';

let capturedCallerAgentId: string | undefined;

/** Capture exactly once at the CLI boundary, then remove the inherited marker. */
export function captureCliCallerIdentity(): void {
  capturedCallerAgentId = process.env[CALLER_AGENT_ID_ENV];
  delete process.env[CALLER_AGENT_ID_ENV];
}

/** Commands consume only this operation-scoped capability, never the raw marker. */
export function getCapturedCliMotionAccess(operation: MotionOperation): MotionAccessCapability {
  return createCapturedCliMotionAccess(capturedCallerAgentId, operation);
}

interface MotionCliGuardDeps {
  /** Denial audit is wired by the composition root; tests can observe it without FS. */
  onDenied?: (error: MotionAccessDeniedError) => void;
}

/** Register the global preAction hook before action/supervision/audit scope. */
export function registerMotionCliGuard(program: Command, deps: MotionCliGuardDeps = {}): void {
  program.hook('preAction', withCliErrorHandling((_thisCommand, actionCommand) => {
    assertMotionCliAccessAllowed(actionCommand, deps);
  }));
}

export function assertMotionCliAccessAllowed(command: Command, deps: MotionCliGuardDeps = {}): void {
  const classification = classifyMotionCliCommand(command);
  if (!classification) return;
  try {
    requireMotionAccess(
      getCapturedCliMotionAccess(classification.operation),
      classification.operation,
      classification.commandName,
    );
  } catch (error) {
    if (error instanceof MotionAccessDeniedError) {
      try {
        deps.onDenied?.(error);
      } catch (auditError) {
        console.error(`Motion access denial audit failed: ${String(auditError)}`);
      }
      throw new CliError(error.message);
    }
    throw error;
  }
}
