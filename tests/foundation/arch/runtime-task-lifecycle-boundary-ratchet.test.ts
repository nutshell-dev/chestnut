import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1359: Runtime task lifecycle boundary', () => {
  it('owner lifecycle contains exactly the four Runtime operations', () => {
    const source = read('src/core/async-task-system/types.ts');
    const body = source.match(/export interface AsyncTaskRuntimeLifecycle \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(4);
    for (const member of ['initialize', 'startDispatch', 'shutdown', 'abort']) {
      expect(body).toContain(`${member}(`);
    }
    expect(body).not.toContain('setParentStreamLog(');
    expect(body).not.toContain('schedule(');
  });

  it('Runtime sees only lifecycle and exposes no task-system getter', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');
    expect(types).toContain('readonly taskSystem: AsyncTaskRuntimeLifecycle');
    expect(runtime).toContain('private taskSystem!: AsyncTaskRuntimeLifecycle');
    expect(runtime).not.toContain('getTaskSystem()');
    expect(runtime).not.toMatch(/import type \{ AsyncTaskSystem \}/);
  });

  it('Assembly passes its owned instance directly to MemorySystem', () => {
    const source = read('src/assembly/motion-addons.ts');
    expect(source).toContain('taskSystem: business.taskSystem');
    expect(source).not.toContain('runtime.getTaskSystem()');
  });
});
