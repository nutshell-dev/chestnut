import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('phase 1362: Runtime snapshot commit boundary', () => {
  it('owner committer contains exactly one operation', () => {
    const source = read('src/foundation/snapshot/snapshot.ts');
    const body = source.match(/export interface SnapshotCommitter \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(body).toBeDefined();
    expect(body?.match(/^\s*[a-zA-Z][A-Za-z]+\(/gm)).toHaveLength(1);
    expect(body).toContain('commit(message: string): Promise<SnapshotCommitResult>');
    expect(source).toContain('export class Snapshot implements SnapshotCommitter');
  });

  it('Runtime sees only the committer', () => {
    const types = read('src/core/runtime/types.ts');
    const runtime = read('src/core/runtime/runtime.ts');
    expect(types).toContain('readonly snapshot: SnapshotCommitter');
    expect(runtime).toContain('private snapshot!: SnapshotCommitter');
    expect(types).not.toMatch(/import type \{ Snapshot \}/);
    expect(runtime).not.toMatch(/import type \{ Snapshot \}/);
  });

  it('Runtime retains both commit boundaries', () => {
    const source = read('src/core/runtime/runtime.ts');
    expect(source.match(/this\.snapshot\.commit\(/g)).toHaveLength(2);
  });
});
