/**
 * @module L6.CLI.Commands.MessageRenderer.SessionParser
 * phase 31 P2.5: session history 解析函数集。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { Message, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock } from '../../foundation/llm-provider/index.js';
import { CliError } from '../errors.js';
import { migrateAndValidateSession, validateSessionData } from '../../foundation/dialog-store/index.js';

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
  const baseDir = path.dirname(filePath);
  const relPath = path.basename(filePath);
  const fileSystem = deps.fsFactory(baseDir);

  // path 1: current.json exists → read directly
  if (fileSystem.existsSync(relPath)) {
    const raw = JSON.parse(fileSystem.readSync(relPath));
    const session = migrateAndValidateSession(raw, relPath);
    if (!session) throw new CliError(`dialog session version unknown: ${filePath}`);
    return {
      session: validateSessionData(session) as SessionLike,
      source: 'current',
    };
  }

  // path 2: cold-start fallback → latest archive under archive/
  const archiveDir = path.join(baseDir, 'archive');
  const archiveFs = deps.fsFactory(archiveDir);
  if (!archiveFs.existsSync('.')) {
    throw new CliError(`dialog session not found: ${filePath} (archive/ also missing)`);
  }
  const latestArchive = findLatestArchiveSync(archiveFs);
  if (!latestArchive) {
    throw new CliError(`dialog session not found: ${filePath} (archive/ empty)`);
  }
  const raw = JSON.parse(archiveFs.readSync(latestArchive));
  const session = migrateAndValidateSession(raw, latestArchive);
  if (!session) throw new CliError(`dialog session version unknown: archive/${latestArchive}`);
  return {
    session: validateSessionData(session) as SessionLike,
    source: 'archive',
    archiveName: latestArchive,
  };
}

function findLatestArchiveSync(archiveFs: FileSystem): string | null {
  const entries = archiveFs.listSync('.');
  const archives = entries
    .filter((e) => e.isFile && e.name.endsWith('.json') && /^\d+_/.test(e.name))
    .map((e) => ({ name: e.name, ts: parseInt(e.name.split('_')[0], 10) }))
    .filter((a) => !isNaN(a.ts))
    .sort((a, b) => b.ts - a.ts);
  return archives.length > 0 ? archives[0].name : null;
}
