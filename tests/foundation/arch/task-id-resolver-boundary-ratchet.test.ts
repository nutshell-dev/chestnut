import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1357: task ID resolver boundary', () => {
  it('owner defines a one-method read capability extended by the full index', () => {
    const source = read('src/core/async-task-system/types.ts');
    const body = source.match(/export interface TaskIdResolver \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(1);
    expect(body).toContain('resolve(shortId: string): FullTaskId | undefined');
    expect(source).toContain('export interface ShortIdIndex extends TaskIdResolver');
  });

  it('owner barrel publishes the read capability', () => {
    const source = read('src/core/async-task-system/index.ts');
    expect(source).toMatch(/export type \{[^}]*TaskIdResolver[^}]*\} from '\.\/types\.js'/s);
  });

  it('query consumers cannot see the full mutable index', () => {
    for (const relative of [
      'src/cli/commands/subagent-helpers.ts',
      'src/core/memory/random-dream.ts',
      'src/core/async-task-system/list-migrated-exec.ts',
    ]) {
      const source = read(relative);
      expect(source).toContain('TaskIdResolver');
      expect(source).not.toMatch(/\btype ShortIdIndex\b/);
    }
  });
});
