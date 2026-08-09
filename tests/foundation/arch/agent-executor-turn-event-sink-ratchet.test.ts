import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1356: AgentExecutor turn-event sink boundary', () => {
  it('facade and executor depend on the three-member turn-event sink', () => {
    for (const relative of [
      'src/core/agent-executor/loop.ts',
      'src/core/agent-executor/agent-executor.ts',
    ]) {
      const source = read(relative);
      expect(source).toMatch(/streamCallbacks\?: TurnEventCommitDeps/);
      expect(source).not.toMatch(/import type \{ StreamCallbacks \}/);
    }
  });

  it('AgentExecutor passes the narrowed sink directly to the owner commit function', () => {
    const source = read('src/core/agent-executor/agent-executor.ts');
    expect(source).toContain('const turnEventSink = input.streamCallbacks');
    expect(source).toContain("commitTurnEvent({ kind: 'text_end' }, turnEventSink)");
    expect(source).not.toMatch(/const streamDeps:[\s\S]*?onToolResult:/);
  });

  it('the owner sink remains exactly the three turn-event callbacks', () => {
    const source = read('src/core/agent-executor/turn-event-commit.ts');
    const body = source.match(/export interface TurnEventCommitDeps \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(body).toBeDefined();
    expect(body?.match(/^\s*on[A-Z][A-Za-z]+\?/gm)).toHaveLength(3);
  });
});
