/**
 * @module L6.CLI.Utils.ClawStatusHint
 *
 * Pure string formatter for the no-active-contract hint.
 * Used by cli commands (claw send via claw-shared).
 *
 * phase 540: extracted from cli/commands/claw-shared to break the
 * assembly → cli reverse import that the original location forced.
 * phase 1278 Step A: daemon status hint formatter 归位 CLIProtocol
 * （src/cli-protocol/claw-status-hint.ts，经 public barrel 消费）；
 * 本文件只保留下方 no-active-contract formatter（CLIProcess 唯一消费，
 * 独立归属审查留后续 phase）。
 */

/**
 * Format a hint message for caller when target claw has no active contract.
 *
 * Symmetric with the CLIProtocol-owned daemon status hint: accepts boolean param, returns undefined when contract exists.
 * @returns hint string asking to request reply via send tool, or undefined if there is an active contract.
 * @example
 *   formatNoActiveContractHint('my-claw', false)
 *     === 'No active contract for "my-claw". Ask claw to reply via send tool in message body.'
 *   formatNoActiveContractHint('my-claw', true) === undefined
 */
export function formatNoActiveContractHint(clawName: string, hasActiveContract: boolean): string | undefined {
  if (hasActiveContract) return undefined;
  return `No active contract for "${clawName}". Ask claw to reply via send tool in message body.`;
}
