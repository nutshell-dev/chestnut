import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Runtime StreamCallbacks owner boundary (phase 1504)', () => {
  it('AgentExecutor barrel remains the StreamCallbacks protocol owner', () => {
    expect(read('src/core/agent-executor/index.ts')).toMatch(
      /export type \{ StreamCallbacks \} from '\.\/stream-callbacks\.js';/,
    );
  });

  it('Runtime implementation imports StreamCallbacks directly from AgentExecutor', () => {
    expect(read('src/core/runtime/runtime.ts')).toMatch(
      /import \{[^}]*runReact[^}]*type StreamCallbacks[^}]*\} from '\.\.\/agent-executor\/index\.js';/s,
    );
  });

  it('EventLoop stream adapter imports StreamCallbacks directly from AgentExecutor', () => {
    expect(read('src/core/event-loop/stream-callbacks.ts')).toMatch(
      /import type \{ StreamCallbacks \} from '\.\.\/agent-executor\/index\.js';/,
    );
  });

  it('Runtime does not forward StreamCallbacks', () => {
    expect(read('src/core/runtime/types.ts')).not.toContain('StreamCallbacks');
    expect(read('src/core/runtime/index.ts')).not.toContain('StreamCallbacks');
  });

  it('cross-module test helpers consume StreamCallbacks through the owner barrel', () => {
    expect(read('tests/helpers/legacy-process-batch.ts')).toContain(
      "from '../../src/core/agent-executor/index.js'",
    );
  });
});
