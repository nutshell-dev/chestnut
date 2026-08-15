import { describe, expect, expectTypeOf, it } from 'vitest';
import * as fs from 'node:fs';
import type { Runtime } from '../../../src/core/runtime/index.js';
import type {
  EventLoopRuntime,
  EventLoopTraceSource,
} from '../../../src/core/event-loop/index.js';

describe('phase 1351: EventLoop consumer-owned Runtime capability', () => {
  it('the production Runtime structurally satisfies both EventLoop capabilities', () => {
    expectTypeOf<Runtime>().toMatchTypeOf<EventLoopRuntime>();
    expectTypeOf<Runtime>().toMatchTypeOf<EventLoopTraceSource>();
  });

  it('EventLoop source no longer imports the concrete Runtime type', () => {
    const files = [
      'src/core/event-loop/types.ts',
      'src/core/event-loop/event-loop.ts',
      'src/core/event-loop/stream-callbacks.ts',
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/import type \{[^}]*\bRuntime\b[^}]*\} from ['"]\.\.\/runtime\/index\.js['"]/s);
    }
  });

  it('the public EventLoop barrel exposes capability types without runtime values', () => {
    const source = fs.readFileSync('src/core/event-loop/index.ts', 'utf8');
    expect(source).toContain('export type { EventLoopRuntime, EventLoopTraceSource }');
  });
});
