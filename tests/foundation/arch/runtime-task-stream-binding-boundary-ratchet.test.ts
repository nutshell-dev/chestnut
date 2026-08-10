import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1366: task stream binding ownership boundary', () => {
  it('Assembly owns the direct stream binding and does not pass it through Runtime deps', () => {
    const assembly = read('src/assembly/runtime-assembly.ts');

    expect(assembly).toContain('taskSystem.setParentStreamLog(streamWriter)');
    expect(assembly).not.toContain('parentStreamLog: streamWriter');
  });

  it('Runtime neither declares nor performs task stream binding', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');

    expect(types).not.toContain('parentStreamLog');
    expect(runtime).not.toContain('parentStreamLog');
    expect(runtime).not.toContain('.setParentStreamLog(');
  });

  it('the owner concrete API keeps the Assembly entry while Runtime lifecycle excludes it', () => {
    const system = read('src/core/async-task-system/system.ts');
    const types = read('src/core/async-task-system/types.ts');
    const lifecycle = types.match(/export interface AsyncTaskRuntimeLifecycle \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(system).toContain('setParentStreamLog(streamLog: StreamLog): void');
    expect(lifecycle).toBeDefined();
    expect(lifecycle).not.toContain('setParentStreamLog');
  });
});
