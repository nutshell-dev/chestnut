/**
 * @module L6.CLI.Utils.ClawStatusHint
 *
 * Pure string formatters for claw status hints.
 * Used by notify-claw tool deps + cli commands.
 *
 * phase 540: extracted from cli/commands/claw-shared to break the
 * assembly → cli reverse import that the original location forced.
 * Lives in foundation/utils as a leaf string-formatter helper.
 */

/**
 * Format a hint message for caller when target claw is not running.
 *
 * @returns hint string with restart instruction, or undefined if claw is alive.
 * @example
 *   formatClawStatusHint('my-claw', false)
 *     === 'Note: claw "my-claw" is not running. Start it with: chestnut claw my-claw daemon'
 *   formatClawStatusHint('my-claw', true) === undefined
 */
export function formatClawStatusHint(clawName: string, isAlive: boolean): string | undefined {
  if (isAlive) return undefined;
  return `Note: claw "${clawName}" is not running. Start it with: chestnut claw ${clawName} daemon`;
}

/**
 * Format a hint message for caller when target claw has no active contract.
 *
 * Symmetric with `formatClawStatusHint`: accepts boolean param, returns undefined when contract exists.
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
