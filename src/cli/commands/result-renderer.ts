/**
 * @module L6.CLI.Commands.MessageRenderer.ResultRenderer
 * phase 31 P2.5: result rendering 函数集。
 */

import type { ToolUseBlock, ToolResultBlock } from '../../foundation/llm-provider/types.js';
import { CliError } from '../errors.js';
import { type Turn } from './session-parser.js';
import { renderArgs, renderArgsFull, truncateSingleLine } from './arg-renderer.js';

function renderResult(result: ToolResultBlock | undefined): string {
  if (!result) return '→ (pending)';
  const content = result.content;
  if (result.is_error) {
    const lines = content.split('\n');
    if (lines.length > 1) return `→ ERR ${truncateSingleLine(content, 60)} (${lines.length} lines)`;
    return `→ ERR ${truncateSingleLine(content, 60)}`;
  }
  if (content === '' || content.trim() === '') return '→ ok';
  const lines = content.split('\n');
  if (lines.length > 1) return `→ ${truncateSingleLine(content, 60)} (${lines.length} lines)`;
  if (content.length <= 60) return `→ ${content}`;
  return `→ ${truncateSingleLine(content, 60)}`;
}

function slotLetter(idx: number): string {
  // 0 -> 'a', 1 -> 'b', ...
  return String.fromCharCode(97 + idx);
}

function marker(label: string): string {
  return `=== ${label} ===`;
}

function renderToolUseSections(tu: ToolUseBlock, result: ToolResultBlock | undefined, slotLabel: string): string[] {
  const sections: string[] = [];
  const callHeader = slotLabel ? `call ${slotLabel}: ${tu.name}` : `call: ${tu.name}`;
  const argsBody = renderArgsFull(tu.input);
  sections.push(argsBody ? `${marker(callHeader)}\n\n${argsBody}` : marker(callHeader));

  const resultLabel = slotLabel ? `result ${slotLabel}` : 'result';
  if (!result) {
    sections.push(marker(`${resultLabel}: (pending)`));
  } else if (result.is_error) {
    sections.push(`${marker(`${resultLabel}: ERR`)}\n\n${result.content}`);
  } else {
    sections.push(`${marker(resultLabel)}\n\n${result.content}`);
  }
  return sections;
}

export function renderSteps(turns: Turn[]): string {
  const lines: string[] = ['TURN  CALL  RESULT'];

  for (const turn of turns) {
    // text-only turns
    if (turn.toolUses.length === 0 && turn.texts.length > 0) {
      const text = turn.texts.join(' ');
      lines.push(`${turn.num}  (text) "${truncateSingleLine(text, 80)}"`);
      continue;
    }

    // tool_use turns
    const multi = turn.toolUses.length > 1;
    turn.toolUses.forEach((tu, idx) => {
      const argsStr = renderArgs(tu.name, tu.input);
      const result = renderResult(turn.toolResults.get(tu.id));
      const turnLabel = multi ? `${turn.num}.${slotLetter(idx)}` : String(turn.num);
      lines.push(`${turnLabel}  ${argsStr}  ${result}`);
    });
  }

  return lines.join('\n');
}

export function renderStepFull(turn: Turn, slotIdx?: number): string {
  if (slotIdx !== undefined) {
    if (slotIdx < 0 || slotIdx >= turn.toolUses.length) {
      throw new CliError(`slot ${slotLetter(slotIdx)} out of range (turn ${turn.num} has ${turn.toolUses.length} tool_use)`);
    }
    const tu = turn.toolUses[slotIdx];
    const slotLabel = turn.toolUses.length > 1 ? `${turn.num}.${slotLetter(slotIdx)}` : String(turn.num);
    const result = turn.toolResults.get(tu.id);
    const sections = [`turn ${slotLabel}`, ...renderToolUseSections(tu, result, '')];
    return sections.join('\n\n') + '\n';
  }

  const sections: string[] = [`turn ${turn.num}`];
  for (const thinking of turn.thinkings) {
    sections.push(`${marker('thinking')}\n\n${thinking}`);
  }
  for (const text of turn.texts) {
    sections.push(`${marker('text')}\n\n${text}`);
  }
  const multi = turn.toolUses.length > 1;
  turn.toolUses.forEach((tu, idx) => {
    const slotLabel = multi ? slotLetter(idx) : '';
    const result = turn.toolResults.get(tu.id);
    sections.push(...renderToolUseSections(tu, result, slotLabel));
  });

  return sections.join('\n\n') + '\n';
}
