import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('AsyncTaskSystem formatErr owner boundary (phase 1501)', () => {
  it('NodeUtils remains the named-export owner', () => {
    expect(read('src/foundation/node-utils/index.ts')).toMatch(
      /export \{ formatErr \} from '\.\/format\.js';/,
    );
  });

  it('AsyncTask helpers do not import formatErr', () => {
    expect(read('src/core/async-task-system/_helpers.ts')).not.toMatch(
      /import \{[^}]*formatErr[^}]*\}/,
    );
  });

  it('AsyncTask helpers do not export formatErr', () => {
    expect(read('src/core/async-task-system/_helpers.ts')).not.toMatch(
      /export \{[^}]*formatErr[^}]*\}/,
    );
  });

  it('AsyncTask consumers do not import formatErr from helpers', () => {
    const asyncTaskDir = path.join(root, 'src/core/async-task-system');
    const source = fs
      .readdirSync(asyncTaskDir)
      .filter(name => name.endsWith('.ts'))
      .map(name => fs.readFileSync(path.join(asyncTaskDir, name), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(
      /import \{[^}]*formatErr[^}]*\} from ['"]\.\/_helpers\.js['"];?/,
    );
  });

  it('AsyncTask helpers retain task error classification', () => {
    expect(read('src/core/async-task-system/_helpers.ts')).toMatch(
      /export function classifyTaskError\(err: unknown\): string/,
    );
  });
});
