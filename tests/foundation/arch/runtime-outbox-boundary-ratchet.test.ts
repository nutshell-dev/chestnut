import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1363: OutboxWriter consumer boundary', () => {
  it('Runtime has no outbound-message dependency', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');
    const assembly = read('src/assembly/runtime-assembly.ts');

    expect(types).not.toMatch(/OutboxWriter|outboxWriter/);
    expect(runtime).not.toMatch(/OutboxWriter|outboxWriter/);
    expect(assembly).not.toMatch(/OutboxWriter|outboxWriter/);
  });

  it('AsyncTaskSystem has no outbound-message dependency', () => {
    const types = read('src/core/async-task-system/types.ts');
    const system = read('src/core/async-task-system/system.ts');

    expect(types).not.toMatch(/OutboxWriter|outboxWriter/);
    expect(system).not.toMatch(/OutboxWriter|outboxWriter/);
  });

  it('Assembly retains OutboxWriter only for the send tool', () => {
    const source = read('src/assembly/business-systems.ts');
    const taskConstruction = source.match(
      /taskSystem = createAsyncTaskSystem\([\s\S]*?\n\s*\}\);/,
    )?.[0];

    expect(taskConstruction).toBeDefined();
    expect(taskConstruction).not.toContain('outboxWriter');
    expect(source.match(/createSendTool\(outboxWriter, MOTION_CLAW_ID\)/g)).toHaveLength(1);
  });
});
