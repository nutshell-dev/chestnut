import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1355: Runtime consumer capability ownership', () => {
  it('Runtime owner does not publish false consumer views', () => {
    const runtimeTypes = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(runtimeTypes).not.toContain('IRuntimeLifecycle');
    expect(runtimeTypes).not.toContain('IRuntimeDaemon');
    expect(runtime).not.toMatch(/implements\s+IRuntime/);
    expect(runtimeTypes).toContain('export interface PendingTurnFacts');
  });

  it('EventLoop owns its real Runtime capability without importing the concrete class', () => {
    const eventLoopTypes = read('src/core/event-loop/types.ts');

    expect(eventLoopTypes).toContain('export interface EventLoopRuntime');
    expect(eventLoopTypes).not.toMatch(/import\s+(?:type\s+)?\{[^}]*\bRuntime\b[^}]*\}\s+from\s+'\.\.\/runtime\/index\.js'/s);
  });
});
