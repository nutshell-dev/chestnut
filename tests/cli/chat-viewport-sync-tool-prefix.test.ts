import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewportPath = path.join(__dirname, '../../src/cli/commands/chat-viewport.ts');
const eventHandlerPath = path.join(__dirname, '../../src/cli/commands/chat-viewport-event-handler.ts');

describe('chat-viewport tool call display (unified, no special prefix)', () => {
  const sourceCode = fs.readFileSync(viewportPath, 'utf-8')
    + fs.readFileSync(eventHandlerPath, 'utf-8');

  it('tool_call case uses unified displayName = toolName', () => {
    const toolCallStart = sourceCode.indexOf("case 'tool_call':");
    expect(toolCallStart).toBeGreaterThan(-1);
    const nextCase = sourceCode.indexOf('case ', toolCallStart + 1);
    const block = sourceCode.slice(toolCallStart, nextCase > toolCallStart ? nextCase : toolCallStart + 600);

    // All tools use the same display format — no special spawn/shadow prefix
    expect(block).toContain('const displayName = toolName;');
  });

  it('no spawn: or shadow: colon suffix', () => {
    const toolCallStart = sourceCode.indexOf("case 'tool_call':");
    const nextCase = sourceCode.indexOf('case ', toolCallStart + 1);
    const block = sourceCode.slice(toolCallStart, nextCase > toolCallStart ? nextCase : toolCallStart + 600);

    expect(block).not.toContain("`${toolName}:`");
  });

  it('appendOutput uses displayName', () => {
    const toolCallStart = sourceCode.indexOf("case 'tool_call':");
    const nextCase = sourceCode.indexOf('case ', toolCallStart + 1);
    const block = sourceCode.slice(toolCallStart, nextCase > toolCallStart ? nextCase : toolCallStart + 600);

    expect(block).toContain('displayName');
    expect(block).toContain(`⚙ \${displayName}`);
  });

  it('default tool (e.g. exec) uses bare toolName without conditional prefix', () => {
    const toolCallStart = sourceCode.indexOf("case 'tool_call':");
    const nextCase = sourceCode.indexOf('case ', toolCallStart + 1);
    const block = sourceCode.slice(toolCallStart, nextCase > toolCallStart ? nextCase : toolCallStart + 600);

    // No conditional logic for specific tool names
    expect(block).not.toContain("toolName === 'spawn'");
    expect(block).not.toContain("toolName === 'shadow'");
  });
});
