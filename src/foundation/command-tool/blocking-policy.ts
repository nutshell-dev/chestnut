/**
 * Phase 2135 Step C: reject only commands whose known shape can hold the
 * current turn beyond the synchronous budget. Auto-migrating exec calls pass
 * no timeout and therefore remain eligible for the existing async path.
 */

import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { COMMAND_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { COMMAND_TOOL_DEFAULT_TIMEOUT_MS, EXEC_COMMAND_PLACEHOLDER_CHARS } from './constants.js';

export const EXEC_TURN_SYNC_LIMIT_MS = COMMAND_TOOL_DEFAULT_TIMEOUT_MS;
export const EXEC_LONG_BLOCKING_REJECTED = 'exec_long_blocking_rejected' as const;

const ASYNC_CAPABILITY = 'async_exec_task_result';
const ASYNC_SUGGESTION =
  'For main-agent exec, omit timeoutMs to use automatic async migration and consume the ' +
  'inbox task_result. In a subagent/shadow, return control to the caller, which owns the ' +
  'async wait; do not sleep or poll for completion.';

export type LongBlockingRuleId = 'exec_long_sleep' | 'exec_fixed_interval_poll' | 'exec_watch_poll';

export interface LongBlockingExecMatch {
  readonly ruleId: LongBlockingRuleId;
  readonly commandSummary: string;
  readonly timeoutMs: number;
  readonly observedSleepMs?: number;
}

interface ShellWord {
  readonly value: string;
}

interface ShellOperator {
  readonly operator: string;
}

type ShellToken = ShellWord | ShellOperator;

function isOperator(token: ShellToken | undefined): token is ShellOperator {
  return token !== undefined && 'operator' in token;
}

/**
 * A deliberately small POSIX-shell lexer. Unsupported/ambiguous syntax returns null so
 * classification can fail open instead of guessing from substrings.
 */
function lexShell(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let value = '';
  let hasWord = false;
  let quote: "'" | '"' | undefined;

  const flushWord = (): void => {
    if (!hasWord) return;
    tokens.push({ value });
    value = '';
    hasWord = false;
  };
  const pushOperator = (operator: string): void => {
    flushWord();
    tokens.push({ operator });
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else value += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\') {
        if (i + 1 >= command.length) return null;
        value += command[++i];
      } else value += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
    } else if (char === '\\') {
      if (i + 1 >= command.length) return null;
      value += command[++i];
      hasWord = true;
    } else if (/\s/.test(char)) {
      flushWord();
      if (char === '\n') tokens.push({ operator: ';' });
    } else if (char === '#' && !hasWord) {
      flushWord();
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (char === ';') {
      pushOperator(char);
    } else if (char === '|') {
      const next = command[i + 1];
      pushOperator(next === '|' ? '||' : '|');
      if (next === '|') i++;
    } else if (char === '&') {
      const next = command[i + 1];
      if (next !== '&') return null; // background execution is outside this policy's model
      pushOperator('&&');
      i++;
    } else if (char === '`' || char === '<' || char === '>' || char === '(' || char === ')') {
      return null; // substitutions, heredocs/redirection and subshells: fail open
    } else if (char === '$' && command[i + 1] === '(') {
      return null;
    } else {
      value += char;
      hasWord = true;
    }
  }
  if (quote !== undefined) return null;
  flushWord();
  return tokens;
}

function splitSimpleCommands(tokens: ShellToken[]): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) commands.push(current);
    current = [];
  };
  for (const token of tokens) {
    if (isOperator(token)) flush();
    else current.push(token.value);
  }
  flush();
  return commands;
}

function commandIndex(words: string[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  while (index < words.length && ['do', 'then', 'else', 'time', 'command', '!'].includes(words[index])) index++;
  return index;
}

function commandName(words: string[]): string | undefined {
  const name = words[commandIndex(words)];
  if (name === 'sleep' || name === '/bin/sleep' || name === '/usr/bin/sleep') return 'sleep';
  if (name === 'watch' || name === '/usr/bin/watch' || name === '/bin/watch') return 'watch';
  return name;
}

function sleepDurationMs(words: string[]): number | undefined {
  const index = commandIndex(words);
  if (commandName(words) !== 'sleep') return undefined;
  let argumentIndex = index + 1;
  if (words[argumentIndex] === '--') argumentIndex++;
  const argument = words[argumentIndex];
  if (argumentIndex + 1 !== words.length) return undefined; // exactly one static operand
  const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd])?$/.exec(argument ?? '');
  if (!match) return undefined;
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const unit = (match[2] ?? 's') as keyof typeof multiplier;
  return Number(match[1]) * multiplier[unit];
}

function isWatchPoll(words: string[]): boolean {
  const index = commandIndex(words);
  if (commandName(words) !== 'watch') return false;
  let hasObservedCommand = false;
  for (let i = index + 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--help' || word === '--version') return false;
    if (word === '-n' || word === '--interval') {
      const interval = Number(words[++i]);
      if (!Number.isFinite(interval) || interval <= 0) return false;
      continue;
    }
    const inlineInterval = /^(-n|--interval=)(\d+(?:\.\d+)?|\.\d+)$/.exec(word);
    if (inlineInterval) {
      if (Number(inlineInterval[2]) <= 0) return false;
      continue;
    }
    if (word.startsWith('-')) return false;
    hasObservedCommand = true;
  }
  return hasObservedCommand;
}

function summarizeCommand(command: string): string {
  const summary = command.replace(/\s+/g, ' ').trim();
  return summary.length > EXEC_COMMAND_PLACEHOLDER_CHARS
    ? `${summary.slice(0, EXEC_COMMAND_PLACEHOLDER_CHARS)}[truncated]`
    : summary;
}

/** Pure structural classification; unknown/dynamic shell shapes are deliberately allowed. */
export function evaluateLongBlockingExec(
  command: string,
  timeoutMs: number | undefined,
): LongBlockingExecMatch | null {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= EXEC_TURN_SYNC_LIMIT_MS) {
    return null;
  }

  const tokens = lexShell(command);
  if (tokens === null) return null;
  const commands = splitSimpleCommands(tokens);
  for (const words of commands) {
    const sleepMs = sleepDurationMs(words);
    if (sleepMs !== undefined && sleepMs > EXEC_TURN_SYNC_LIMIT_MS) {
      return { ruleId: 'exec_long_sleep', commandSummary: summarizeCommand(command), timeoutMs, observedSleepMs: sleepMs };
    }
    if (isWatchPoll(words)) {
      return { ruleId: 'exec_watch_poll', commandSummary: summarizeCommand(command), timeoutMs };
    }
  }

  const loops: Array<{ inBody: boolean; hasFixedSleep: boolean; hasExplicitExit: boolean }> = [];
  for (const words of commands) {
    let first = words[0];
    if (first === 'while' || first === 'until') {
      loops.push({ inBody: false, hasFixedSleep: false, hasExplicitExit: false });
      continue;
    }
    const current = loops[loops.length - 1];
    if (current === undefined) continue;
    let commandWords = words;
    if (first === 'do') {
      current.inBody = true;
      commandWords = words.slice(1); // `do sleep 5` is one token run without a semicolon
      first = commandWords[0];
      if (first === undefined) continue;
    }
    if (first === 'done') {
      loops.pop();
      if (current.inBody && current.hasFixedSleep && !current.hasExplicitExit) {
        return { ruleId: 'exec_fixed_interval_poll', commandSummary: summarizeCommand(command), timeoutMs };
      }
      continue;
    }
    if (!current.inBody) continue; // `until sleep 5; do ...` sleeps in the condition, not the body
    if (['break', 'continue', 'return', 'exit'].includes(first)) {
      current.hasExplicitExit = true;
      continue;
    }
    const sleepMs = sleepDurationMs(commandWords);
    if (sleepMs !== undefined && sleepMs > 0) current.hasFixedSleep = true;
  }
  return null;
}

/** Audit and format the single typed rejection used by plain and async-wrapped exec. */
export function rejectLongBlockingExec(
  command: string,
  timeoutMs: number | undefined,
  ctx: ExecContext,
): ToolResult | null {
  // Preserve the existing L1 abort outcome and do not apply POSIX rules to cmd/PowerShell.
  if (ctx.signal?.aborted || process.platform === 'win32') return null;
  const match = evaluateLongBlockingExec(command, timeoutMs);
  if (match === null) return null;

  ctx.auditWriter?.write(
    COMMAND_TOOL_AUDIT_EVENTS.EXEC_LONG_BLOCKING_REJECTED,
    `clawId=${ctx.clawId}`,
    `rule_id=${match.ruleId}`,
    'disposition=rejected',
    `command_summary=${match.commandSummary}`,
    `timeout_ms=${match.timeoutMs}`,
    ...(match.observedSleepMs !== undefined ? [`observed_sleep_ms=${match.observedSleepMs}`] : []),
    `async_capability=${ASYNC_CAPABILITY}`,
  );

  return {
    success: false,
    error: EXEC_LONG_BLOCKING_REJECTED,
    content:
      `Error: synchronous exec exceeds the ${EXEC_TURN_SYNC_LIMIT_MS}ms turn budget.\n` +
      `[rule_id]: ${match.ruleId}\n[command]: ${match.commandSummary}\n` +
      `[suggestion]: ${ASYNC_SUGGESTION}`,
    metadata: {
      ruleId: match.ruleId,
      disposition: 'rejected',
      commandSummary: match.commandSummary,
      asyncCapability: ASYNC_CAPABILITY,
    },
  };
}
