/**
 * @module L6.CLI.Commands.MessageRenderer.SessionParser
 * phase 31 P2.5: session history 解析函数集。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import { CliError } from '../errors.js';
// phase 1879 Step C: dialog 当前/归档两态读取归 DialogStore owner 查询（布局/格式理解归
// owner）；本模块只做结果协议 → CLI 错误文案的呈现映射。
import { loadSessionFile } from '../../foundation/dialog-store/index.js';

export interface Step {
  num: number;
  userInput?: { content: string; chars: number };
  texts: string[];
  thinkings: string[];
  toolUses: ToolUseBlock[];
  toolResults: Map<string, ToolResultBlock>;
}

export interface SessionLike {
  messages: Message[];
}

export interface SessionLoadResult {
  session: SessionLike;
  source: 'current' | 'archive';
  archiveName?: string;
}

export function parseMessagesFromSession(session: SessionLike): Step[] {
  const messages = session.messages;
  const steps: Step[] = [];

  let stepNum = 0;
  let pendingUserInput: { content: string; chars: number } | undefined;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const textContent = extractUserTextContent(msg);
      if (textContent !== undefined) {
        pendingUserInput = { content: textContent, chars: textContent.length };
      }
      continue;
    }
    if (msg.role === 'assistant') {
      stepNum++;
      const blocks = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: msg.content } as TextBlock];

      const nextUserMsg = messages[i + 1]?.role === 'user' ? messages[i + 1] : undefined;
      const toolResults = collectToolResults(nextUserMsg);

      const step: Step = {
        num: stepNum,
        userInput: pendingUserInput,
        texts: [],
        thinkings: [],
        toolUses: [],
        toolResults,
      };

      for (const block of blocks) {
        if (block.type === 'text') step.texts.push((block as TextBlock).text);
        else if (block.type === 'thinking') step.thinkings.push((block as ThinkingBlock).thinking);
        else if (block.type === 'tool_use') step.toolUses.push(block as ToolUseBlock);
      }

      steps.push(step);
      pendingUserInput = undefined;
    }
  }

  return steps;
}

function extractUserTextContent(msg: Message): string | undefined {
  if (typeof msg.content === 'string') return msg.content || undefined;
  if (!Array.isArray(msg.content)) return undefined;
  const textBlocks = msg.content.filter((b): b is TextBlock => b.type === 'text');
  if (textBlocks.length === 0) return undefined;
  return textBlocks.map(b => b.text).join('\n');
}

function collectToolResults(userMsg: Message | undefined): Map<string, ToolResultBlock> {
  const map = new Map<string, ToolResultBlock>();
  if (!userMsg) return map;

  const blocks = Array.isArray(userMsg.content)
    ? userMsg.content
    : [{ type: 'text', text: userMsg.content }];

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const tr = block as ToolResultBlock;
      map.set(tr.tool_use_id, tr);
    }
  }

  return map;
}

export function loadSessionFromFile(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  filePath: string,
): SessionLoadResult {
  const outcome = loadSessionFile(deps.fsFactory(path.dirname(filePath)), filePath);
  switch (outcome.kind) {
    case 'ok':
      return outcome.source === 'current'
        ? { session: outcome.session, source: 'current' }
        : { session: outcome.session, source: 'archive', archiveName: outcome.archiveName };
    case 'not_found':
      throw new CliError(outcome.archiveDirExists
        ? `dialog session not found: ${filePath} (archive/ empty)`
        : `dialog session not found: ${filePath} (archive/ also missing)`);
    case 'rejected':
      throw new CliError(outcome.source === 'current'
        ? `dialog session version unknown: ${filePath}`
        : `dialog session version unknown: archive/${outcome.archiveName}`);
  }
}
