/**
 * @module L6.CLI.Commands.MessageRenderer.SessionParser
 * phase 31 P2.5: session history 解析函数集。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { Message, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock } from '../../foundation/llm-provider/types.js';
import { CliError } from '../errors.js';
import { migrateAndValidateSession, validateSessionData } from '../../foundation/dialog-store/store.js';

export interface Turn {
  num: number;
  texts: string[];
  thinkings: string[];
  toolUses: ToolUseBlock[];
  toolResults: Map<string, ToolResultBlock>;
}

export interface SessionLike {
  messages: Message[];
}

export function parseMessagesFromSession(session: SessionLike): Turn[] {
  const messages = session.messages;
  const turns: Turn[] = [];

  let turnNum = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      turnNum++;
      const blocks = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: msg.content } as TextBlock];

      const nextUserMsg = messages[i + 1]?.role === 'user' ? messages[i + 1] : undefined;
      const toolResults = collectToolResults(nextUserMsg);

      const turn: Turn = {
        num: turnNum,
        texts: [],
        thinkings: [],
        toolUses: [],
        toolResults,
      };

      for (const block of blocks) {
        if (block.type === 'text') turn.texts.push((block as TextBlock).text);
        else if (block.type === 'thinking') turn.thinkings.push((block as ThinkingBlock).thinking);
        else if (block.type === 'tool_use') turn.toolUses.push(block as ToolUseBlock);
      }

      turns.push(turn);
    }
  }

  return turns;
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

export function loadSessionFromFile(deps: { fsFactory: (baseDir: string) => FileSystem }, filePath: string): SessionLike {
  const baseDir = path.dirname(filePath);
  const relPath = path.basename(filePath);
  const fileSystem = deps.fsFactory(baseDir);
  if (!fileSystem.existsSync(relPath)) {
    throw new CliError(`dialog session not found: ${filePath}`);
  }
  const raw = JSON.parse(fileSystem.readSync(relPath));
  const filename = path.basename(filePath);
  const session = migrateAndValidateSession(raw, filename);
  if (!session) throw new CliError(`dialog session version unknown: ${filePath}`);
  return validateSessionData(session) as SessionLike;
}
