/**
 * Stable registry of CLI commands which read or affect Motion.
 * preAction consumes this classification before any command action runs.
 */

import type { Command } from 'commander';
import type { MotionCommandId } from '../cli-protocol/index.js';
import { MOTION_CLAW_ID, type MotionOperation } from '../core/claw-topology/index.js';

export interface MotionCliCommandClassification {
  readonly operation: MotionOperation;
  readonly commandName: string;
}

interface RegistryEntry extends MotionCliCommandClassification {
  readonly path: string;
}

const MOTION_OPERATIONS: Readonly<Record<MotionCommandId, MotionOperation>> = {
  init: 'configure',
  chat: 'start',
  stop: 'stop',
  outbox: 'dispatch',
  steps: 'read',
  step: 'read',
  daemon: 'start',
};

const EXACT_ENTRIES: readonly RegistryEntry[] = [
  { path: 'status', operation: 'read', commandName: 'status' },
  { path: 'stop', operation: 'stop', commandName: 'stop' },
  { path: 'start', operation: 'start', commandName: 'start' },
  { path: 'init', operation: 'configure', commandName: 'init' },
  { path: 'launcher/setup', operation: 'configure', commandName: 'launcher/setup' },
  { path: 'launcher/status', operation: 'read', commandName: 'launcher/status' },
  { path: 'launcher/start', operation: 'start', commandName: 'launcher/start' },
  { path: 'launcher/send', operation: 'dispatch', commandName: 'launcher/send' },
  { path: 'launcher/stream', operation: 'read', commandName: 'launcher/stream' },
  { path: 'watchdog/start', operation: 'start', commandName: 'watchdog/start' },
  { path: 'watchdog/stop', operation: 'stop', commandName: 'watchdog/stop' },
  { path: 'dispatch-skill/list', operation: 'read', commandName: 'dispatch-skill/list' },
  { path: 'dispatch-skill/history', operation: 'read', commandName: 'dispatch-skill/history' },
  { path: 'dispatch-skill/edit/begin', operation: 'dispatch', commandName: 'dispatch-skill/edit/begin' },
  { path: 'dispatch-skill/edit/submit', operation: 'dispatch', commandName: 'dispatch-skill/edit/submit' },
  { path: 'dispatch-skill/edit/basis', operation: 'dispatch', commandName: 'dispatch-skill/edit/basis' },
  { path: 'dispatch-skill/edit/retry', operation: 'dispatch', commandName: 'dispatch-skill/edit/retry' },
  { path: 'dispatch-skill/edit/status', operation: 'read', commandName: 'dispatch-skill/edit/status' },
  { path: 'config/provider/add', operation: 'configure', commandName: 'config/provider/add' },
  { path: 'config/provider/remove', operation: 'configure', commandName: 'config/provider/remove' },
  { path: 'config/provider/set-primary', operation: 'configure', commandName: 'config/provider/set-primary' },
  { path: 'config/provider/move', operation: 'configure', commandName: 'config/provider/move' },
  { path: 'config/provider/login', operation: 'configure', commandName: 'config/provider/login' },
  { path: 'config/provider/logout', operation: 'configure', commandName: 'config/provider/logout' },
];

const CLAW_OPTION_ENTRIES: readonly RegistryEntry[] = [
  { path: 'contract/create', operation: 'configure', commandName: 'contract/create' },
  { path: 'contract/show', operation: 'read', commandName: 'contract/show' },
  { path: 'contract/cancel', operation: 'dispatch', commandName: 'contract/cancel' },
  { path: 'contract/events', operation: 'read', commandName: 'contract/events' },
  { path: 'audit/query', operation: 'audit', commandName: 'audit/query' },
  { path: 'audit/lookup', operation: 'audit', commandName: 'audit/lookup' },
  { path: 'audit/info', operation: 'audit', commandName: 'audit/info' },
  { path: 'subagent/list', operation: 'read', commandName: 'subagent/list' },
  { path: 'subagent/steps', operation: 'read', commandName: 'subagent/steps' },
  { path: 'subagent/step', operation: 'read', commandName: 'subagent/step' },
  { path: 'skill/install', operation: 'configure', commandName: 'skill/install' },
  { path: 'skill/list', operation: 'read', commandName: 'skill/list' },
];

export const MOTION_CLI_COMMAND_REGISTRY = Object.freeze({
  motion: MOTION_OPERATIONS,
  exact: EXACT_ENTRIES,
  clawOption: CLAW_OPTION_ENTRIES,
});

/** Return undefined for ordinary claw/help commands; fail closed for unregistered Motion targets. */
export function classifyMotionCliCommand(command: Command): MotionCliCommandClassification | undefined {
  const path = commandPath(command);
  const commandName = path.join('/');
  const opts = command.opts() as { claw?: unknown };

  if (path[0] === MOTION_CLAW_ID) {
    const operation = MOTION_OPERATIONS[path[1] as MotionCommandId];
    if (!operation) throw new Error(`unregistered motion command: ${commandName}`);
    return { operation, commandName };
  }

  const exact = EXACT_ENTRIES.find((entry) => entry.path === commandName);
  if (exact) return exact;

  if (path[0] === 'skill' && (path[1] === 'install' || path[1] === 'list')
    && opts.claw === undefined) {
    return {
      operation: path[1] === 'install' ? 'configure' : 'read',
      commandName,
    };
  }

  if (commandName === 'contract/events' && command.args[0] === MOTION_CLAW_ID) {
    return { operation: 'read', commandName };
  }

  if (opts.claw === MOTION_CLAW_ID) {
    const registered = CLAW_OPTION_ENTRIES.find((entry) => entry.path === commandName);
    if (!registered) throw new Error(`unregistered motion --claw command: ${commandName}`);
    return registered;
  }

  if (path.length === 1 && path[0] === 'claw') {
    const args = command.args as string[];
    if (args.includes('--help') || args.includes('-h')) return undefined;
    if (args[0] === 'list') return { operation: 'read', commandName: 'claw/list' };
    if (args[0] !== MOTION_CLAW_ID) return undefined;
    const rest = args.slice(1);
    return { operation: clawMotionOperation(rest[0]), commandName: `claw/${MOTION_CLAW_ID}/${rest[0] ?? ''}` };
  }

  return undefined;
}

function clawMotionOperation(verb: string | undefined): MotionOperation {
  if (verb === 'stop') return 'stop';
  if (verb === 'start' || verb === 'daemon' || verb === 'chat') return 'start';
  if (verb === 'create' || verb === 'install' || verb === 'import') return 'configure';
  if (verb === 'send' || verb === 'outbox' || verb === 'outbox-skip') return 'dispatch';
  if (verb === 'audit') return 'audit';
  return 'read';
}

function commandPath(command: Command): string[] {
  const path: string[] = [];
  let current: Command | null = command;
  while (current && current.parent) {
    path.unshift(current.name());
    current = current.parent;
  }
  return path;
}

